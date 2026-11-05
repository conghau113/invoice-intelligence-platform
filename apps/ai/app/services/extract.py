"""Orchestrates /extract: xml -> deterministic parser, pdf/image -> LLM (AI_PIPELINE.md section 4).

LLM output is untrusted text: it is parsed and validated against the generated Invoice model and
nothing else is done with it (never executed, never used as a query). Logs carry counts, codes and
timings only, never document text, field values or provider bodies (CLAUDE.md).
"""

import hashlib
import json
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError

from app.providers.base import ImagePart, LLMError, LLMProvider
from app.providers.pricing import estimate_cost_usd
from app.schemas.generated import (
    Buyer,
    Evidence,
    FieldMeta,
    Invoice,
    InvoiceLine,
    Party,
    VatBreakdownItem,
)
from app.services.pdf_pages import PdfError, render_pdf_pages, sniff_image_mime
from app.services.xml_invoice import XmlInvoiceError, parse_xml_invoice

log = logging.getLogger("ai.extract")

SourceType = Literal["xml", "pdf", "image"]
MAX_FIELD_META = 200  # enforced in code: the provider schema cannot carry maxItems
TOTAL_BUDGET_S = 55.0  # whole /extract call; the API worker gives up at 60 s (T3.2)
MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024  # base64 grows 4/3; Gemini inline request limit ~20 MB
MAX_SCHEMA_RETRIES = 2  # 1 first try + 2 retries that include the validation error
PROMPT_NAME = "invoice_extraction"
PROMPT_VERSION = f"{PROMPT_NAME}/v1"
SYSTEM_PROMPT = (Path(__file__).parent.parent / "prompts" / PROMPT_NAME / "v1.md").read_text(
    encoding="utf-8"
)
FIRST_USER_TEXT = "Extract the invoice from the attached page images."


class ExtractError(Exception):
    """Rendered by the router as {code, message} with `status`."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


def invoice_json_schema() -> dict[str, Any]:
    """The schema the MODEL answers to: the contract schema, except `fieldMeta` is a list.

    A map with free-form keys cannot be enforced by structured output (`{}` is always valid, and
    the real model returned `{}` every time). A list of {path, ...} with minItems 1 can. The list
    is turned back into the contract's map in `_to_contract`; contracts/Zod are not touched.
    """
    schema = Invoice.model_json_schema()
    schema["properties"]["fieldMeta"] = {
        "type": "array",
        "minItems": 1,  # no maxItems: Gemini rejects the schema with it (400), see MAX_FIELD_META
        "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["path", "confidence", "evidence"],
            "properties": {
                "path": {"type": "string", "maxLength": 60},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "evidence": {"anyOf": [{"$ref": "#/$defs/Evidence"}, {"type": "null"}]},
            },
        },
    }
    return schema


def _to_contract(text: str) -> Invoice:
    """Model text -> validated Invoice. Raises ValidationError for any shape problem."""
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("not an object")
    entries = data.get("fieldMeta")
    if isinstance(entries, list):
        if len(entries) > MAX_FIELD_META:
            raise ValueError("too many fieldMeta entries")
        meta: dict[str, Any] = {}
        for entry in entries:
            if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                meta[entry["path"]] = {k: v for k, v in entry.items() if k != "path"}
            else:
                raise ValueError("bad fieldMeta entry")
        data["fieldMeta"] = meta
    return Invoice.model_validate(data)


# Field names of the contract: the only words allowed into a retry prompt. Anything else in a path
# (a model-chosen fieldMeta key, a transcribed word) is printed as "?" so it cannot be echoed back.
_KNOWN_PARTS = frozenset(
    name
    for model in (Invoice, Party, Buyer, InvoiceLine, VatBreakdownItem, FieldMeta, Evidence)
    for name in model.model_fields
)


def describe_errors(err: ValidationError) -> str:
    """Field paths and error kinds only: pydantic's `input` and `msg` can repeat document text."""
    items: list[str] = []
    for e in err.errors(include_input=False, include_url=False)[:20]:
        path = ".".join(
            str(part) if isinstance(part, int) or part in _KNOWN_PARTS else "?" for part in e["loc"]
        )
        items.append(f"{path or 'root'}: {e['type']}")
    return "; ".join(items)


def extract_llm(images: list[ImagePart], provider: LLMProvider) -> dict[str, Any]:
    started = time.monotonic()
    in_tokens = out_tokens = 0
    user_text = FIRST_USER_TEXT
    schema = invoice_json_schema()
    last_problem = ""
    for attempt in range(MAX_SCHEMA_RETRIES + 1):
        # One attempt can take `provider.timeout_s`; start another only if it still fits the
        # budget, so slow answers cannot stack up to 3 x timeout (and be billed 3 times).
        if attempt > 0 and time.monotonic() - started + provider.timeout_s > TOTAL_BUDGET_S:
            log.warning("llm retry skipped: time budget used up after %d attempts", attempt)
            break
        try:
            result = provider.generate(
                system=SYSTEM_PROMPT, user_text=user_text, images=images, json_schema=schema
            )
        except LLMError as err:
            log.warning("llm call failed code=%s attempt=%d", err.code, attempt + 1)
            raise ExtractError(
                err.status, err.code, "The model provider could not answer"
            ) from None
        in_tokens += result.input_tokens
        out_tokens += result.output_tokens  # failed attempts are billed too
        try:
            invoice = _to_contract(result.text)
        # JSONDecodeError is a ValueError. RecursionError: absurdly nested JSON; uncaught it would
        # be a 500, which the worker retries, paying for the model again on every attempt.
        except (ValidationError, ValueError, RecursionError) as err:
            last_problem = (
                describe_errors(err) if isinstance(err, ValidationError) else type(err).__name__
            )
            user_text = (
                f"{FIRST_USER_TEXT}\nYour previous answer was rejected by schema validation: "
                f"{last_problem}\nAnswer again with JSON that matches the schema exactly."
            )
            continue
        latency_ms = int((time.monotonic() - started) * 1000)
        log.info(
            "llm extract ok model=%s attempts=%d in=%d out=%d ms=%d",
            result.model,
            attempt + 1,
            in_tokens,
            out_tokens,
            latency_ms,
        )
        return {
            "invoice": invoice,
            "warnings": [],
            "usage": {
                "model": result.model,
                "promptVersion": PROMPT_VERSION,
                "inputTokens": in_tokens,
                "outputTokens": out_tokens,
                "latencyMs": latency_ms,
                "costUsd": estimate_cost_usd(result.model, in_tokens, out_tokens),
            },
        }
    log.warning("llm output rejected after %d attempts: %s", MAX_SCHEMA_RETRIES + 1, last_problem)
    raise ExtractError(
        422, "EXTRACTION_SCHEMA_INVALID", "The model output did not match the schema"
    )


def extract(
    data: bytes, source_type: SourceType, get_provider: Callable[[], LLMProvider]
) -> dict[str, Any]:
    # The hash is the same value as documents.content_hash, so a log line can be tied to a document
    # without this stateless service knowing its id or anything that is written in it.
    log.info(
        "extract start source=%s bytes=%d sha256=%s",
        source_type,
        len(data),
        hashlib.sha256(data).hexdigest(),
    )
    if source_type == "xml":
        try:
            invoice = parse_xml_invoice(data)
        except XmlInvoiceError as err:
            raise ExtractError(
                413 if err.code == "FILE_TOO_LARGE" else 422, err.code, err.message
            ) from None
        return {"invoice": invoice, "warnings": [], "usage": None}

    if source_type == "pdf":
        try:
            pages = render_pdf_pages(data)
        except PdfError as err:
            raise ExtractError(422, err.code, "The PDF cannot be processed") from None
        if sum(len(p) for p in pages) > MAX_TOTAL_IMAGE_BYTES:
            raise ExtractError(422, "PDF_TOO_LARGE", "The rendered pages are too large to send")
        images = [ImagePart(data=p, mime="image/png") for p in pages]
    else:
        mime = sniff_image_mime(data)
        if mime is None:
            raise ExtractError(422, "IMAGE_UNSUPPORTED", "Only PNG and JPEG images are supported")
        images = [ImagePart(data=data, mime=mime)]
    # Built only now: a bad file is answered without needing (or spending) a provider.
    return extract_llm(images, get_provider())
