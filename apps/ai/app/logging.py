"""Structured logs for the AI service (T7.2, SECURITY.md §7).

Every log record, ours and the libraries' (uvicorn, httpx...), goes through one structlog chain
on the root handler: JSON with `service`, `trace_id`, `span_id` and `tenant_id`, PII redacted. The
call sites keep using `logging.getLogger(...)`; `caplog` in the tests still sees the raw records.

Redaction is the second line of defence (code must not log document content, T3.6) and mirrors
`packages/logger/src/redact.ts`; both run the cases in
`packages/logger/fixtures/redaction-cases.json`.
Names are a heuristic: a rare surname or an English person name in free text is not caught.
Every pattern is bounded, so a long line cannot make the regex engine backtrack for ever.
"""

import logging
import re
import sys
import unicodedata
import uuid
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from typing import Any

import structlog
from opentelemetry import trace

SERVICE_NAME = "invoice-ai"
TENANT_HEADER = "x-tenant-id"

EMAIL = "[EMAIL]"
PHONE = "[PHONE]"
TAX_CODE = "[TAX_CODE]"
NAME = "[NAME]"
REDACTED = "[REDACTED]"

# The tenant of the current request, from the API's X-Tenant-Id header. For logs only: the service
# is stateless and never authorises by it.
tenant_id_var: ContextVar[str | None] = ContextVar("tenant_id", default=None)


def tenant_from_header(value: str | None) -> str | None:
    """A well-formed uuid, in its canonical form; anything else is dropped."""
    if value is None or len(value) != 36:
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


# --- redaction (mirror of packages/logger/src/redact.ts) ---

_SENSITIVE_KEYS = frozenset(
    {
        "email",
        "phone",
        "phonenumber",
        "tel",
        "mobile",
        "taxcode",
        "mst",
        "name",
        "fullname",
        "buyer",
        "seller",
        "address",
    }
)
_SENSITIVE_SUFFIXES = (
    "email",
    "phone",
    "taxcode",
    "address",
    "fullname",
    "buyername",
    "sellername",
    "companyname",
    "customername",
    "personname",
)


def is_sensitive_key(key: str) -> bool:
    k = key.lower().replace("_", "").replace("-", "")
    return k in _SENSITIVE_KEYS or k.endswith(_SENSITIVE_SUFFIXES)


# Python's `re` has no \p{..}: `[^\W_]` is a letter or digit in any script, and upper-case letters
# are listed from the Latin blocks that Vietnamese and English use.
_LETTER_OR_DIGIT = r"[^\W_]"
_LETTER = r"[^\W\d_]"
_UPPER = (
    "["
    + "".join(
        chr(c) for r in (range(0x41, 0x250), range(0x1E00, 0x1F00)) for c in r if chr(c).isupper()
    )
    + "]"
)
_TOKEN = rf"(?:{_LETTER_OR_DIGIT}|[&.'-]){{1,40}}"
_CAP = rf"{_UPPER}(?:{_LETTER}|['-]){{0,30}}"
_NOT_AFTER_WORD = rf"(?<!{_LETTER_OR_DIGIT})"
_NOT_BEFORE_WORD = rf"(?!{_LETTER_OR_DIGIT})"

# Starts where the run of address characters starts, so a long local part is not cut in two.
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,256}@[A-Za-z0-9-]{1,63}"
    r"(?:\.[A-Za-z0-9-]{1,63}){0,30}\.[A-Za-z]{2,24}"
)
_COMPANY_PREFIX_RE = re.compile(
    rf"{_NOT_AFTER_WORD}(?:tổng công ty|công ty|cty|tập đoàn|doanh nghiệp|hợp tác xã)"
    rf"{_NOT_BEFORE_WORD}(?: {{1,3}}{_TOKEN}){{0,8}}",
    re.IGNORECASE,
)
_COMPANY_SUFFIX_RE = re.compile(
    rf"{_NOT_AFTER_WORD}{_CAP}(?:, {_CAP}){{0,3}}(?: (?:and|&) {_CAP})?,? "
    rf"(?:Ltd\.?|LLC|JSC|Inc\.?|PLC|Corp\.?|Co\., Ltd\.?|and Sons|Group){_NOT_BEFORE_WORD}"
)
_SURNAMES = [
    "Nguyễn",
    "Trần",
    "Lê",
    "Phạm",
    "Hoàng",
    "Huỳnh",
    "Phan",
    "Vũ",
    "Võ",
    "Đặng",
    "Bùi",
    "Đỗ",
    "Hồ",
    "Ngô",
    "Dương",
    "Lý",
    "Đinh",
    "Trương",
    "Đào",
    "Lâm",
    "Mai",
    "Trịnh",
    "Lương",
    "Cao",
    "Nguyen",
    "Tran",
    "Pham",
    "Hoang",
    "Huynh",
    "Dang",
    "Bui",
    "Ngo",
    "Duong",
    "Truong",
    "Trinh",
]
_SURNAME_ALT = "|".join([*_SURNAMES, *(s.upper() for s in _SURNAMES)])
_PERSON_RE = re.compile(
    rf"{_NOT_AFTER_WORD}(?:{_SURNAME_ALT}){_NOT_BEFORE_WORD}((?: {_TOKEN}){{1,4}})"
)
# Not part of a longer number, a decimal or a uuid segment; a full stop may end it.
# Not inside a longer number: no letter or digit right before, and no "1-" or "0." (a range, a
# decimal). A dash after a word is fine ("MST-0101234567"). [0-9], not \d: ASCII digits as in TS.
_NOT_IN_NUMBER = rf"{_NOT_AFTER_WORD}(?<![0-9][.-])"
# 10 digits, or 13 for a branch, with or without the dash; a full stop may end it.
_TAX_CODE_RE = re.compile(
    rf"{_NOT_IN_NUMBER}[0-9]{{10}}(?:-?[0-9]{{3}})?(?!{_LETTER_OR_DIGIT}|-|\.[0-9])"
)
# 0xx, (0xx), +84 xx or 84xx, then two groups; spaces, dots or dashes between groups.
_PHONE_RE = re.compile(
    rf"{_NOT_IN_NUMBER}(?<!\+)"
    r"(?:\+84[ .-]?[0-9]{2,3}|84[0-9]{2,3}|0[0-9]{2,3}|\(0[0-9]{2,3}\))"
    r"[ .-]?[0-9]{3,4}[ .-]?[0-9]{3,4}"
    rf"(?!{_LETTER_OR_DIGIT}|-{_LETTER_OR_DIGIT})"
)


def _person_name(match: re.Match[str]) -> str:
    words = match.group(1).split(" ")[1:]
    taken = 0
    while taken < len(words) and words[taken][:1].isupper():
        taken += 1
    if taken == 0:
        return match.group(0)  # a surname alone ("Mai", "Cao") is not a name
    rest = words[taken:]
    return NAME if not rest else f"{NAME} {' '.join(rest)}"


def redact_string(text: str) -> str:
    """Redacts PII patterns in one string. Order matters: emails first, numbers last."""
    # NFC first: "Nguyễn" typed with combining marks would not match the surname list.
    text = unicodedata.normalize("NFC", text)
    text = _EMAIL_RE.sub(EMAIL, text)
    text = _COMPANY_PREFIX_RE.sub(NAME, text)
    text = _COMPANY_SUFFIX_RE.sub(NAME, text)
    text = _PERSON_RE.sub(_person_name, text)
    text = _TAX_CODE_RE.sub(TAX_CODE, text)
    return _PHONE_RE.sub(PHONE, text)


_MAX_DEPTH = 8


def redact_value(value: Any, depth: int = 0) -> Any:
    """A copy of `value` with PII removed: strings by pattern, mapping fields by key."""
    if isinstance(value, str):
        return redact_string(value)
    if isinstance(value, bool | int | float) or value is None:
        return value
    if isinstance(value, bytes | bytearray | memoryview):
        return "[Binary]"
    if depth >= _MAX_DEPTH:
        return "[Truncated]"
    if isinstance(value, Mapping):
        return {
            str(k): REDACTED
            if is_sensitive_key(str(k)) and v is not None
            else redact_value(v, depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, list | tuple | set | frozenset):
        return [redact_value(v, depth + 1) for v in value]
    return redact_string(str(value))  # anything else is logged as its text


# --- structlog chain ---

# Set by this module, never from a log call: ids and metadata, left as they are.
# `time`, `level`, `logger` and `service` are always (over)written by the processors above. The ids
# can also come from a structlog call (`log.info("x", tenant_id=...)`), so they pass unredacted
# only when they have the shape of an id.
_OWN_FIELDS = frozenset({"time", "level", "logger", "service"})
_ID_SHAPES = {
    "trace_id": re.compile(r"[0-9a-f]{32}"),
    "span_id": re.compile(r"[0-9a-f]{16}"),
    "tenant_id": re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
}


def add_correlation(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
    """`service`, and the ids that tie the line to its trace and tenant (absent when unknown)."""
    event["service"] = SERVICE_NAME
    span = trace.get_current_span().get_span_context()
    if span.is_valid:
        event["trace_id"] = format(span.trace_id, "032x")
        event["span_id"] = format(span.span_id, "016x")
    tenant = tenant_id_var.get()
    if tenant is not None:
        event["tenant_id"] = tenant
    return event


def redact_event(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in event.items():
        shape = _ID_SHAPES.get(key)
        if key in _OWN_FIELDS or (
            shape is not None and isinstance(value, str) and shape.fullmatch(value)
        ):
            out[key] = value
        elif is_sensitive_key(key) and value is not None:
            out[key] = REDACTED
        else:
            out[key] = redact_value(value)
    return out


Processor = Callable[[Any, str, dict[str, Any]], Any]
_PRE_CHAIN: list[Processor] = [
    structlog.stdlib.add_log_level,
    structlog.stdlib.add_logger_name,
    structlog.processors.TimeStamper(fmt="iso", utc=True, key="time"),
    add_correlation,
]


def json_formatter() -> logging.Formatter:
    return structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=_PRE_CHAIN,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,  # the traceback as text, then redacted
            structlog.processors.EventRenamer("msg"),
            redact_event,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ],
    )


_HANDLER_NAME = "invoice-json"


def configure_logging(level: str, stream: Any = None) -> logging.Handler:
    """Installs the one JSON handler on the root logger. Returns it (tests read what it writes)."""
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(json_formatter())
    handler.set_name(_HANDLER_NAME)
    root = logging.getLogger()
    # Only a handler of ours is replaced (create_app may run twice); others, like pytest's, stay.
    for old in [h for h in root.handlers if h.get_name() == _HANDLER_NAME]:
        root.removeHandler(old)
    root.addHandler(handler)
    root.setLevel(level.upper())
    # uvicorn installs its own handlers before it imports the app; hand its records to the root
    # handler so access lines (path and query) are redacted too.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lib = logging.getLogger(name)
        lib.handlers.clear()
        lib.propagate = True
    # Libraries log request URLs and whatever a later version decides to add. What they write must
    # not depend on LOG_LEVEL: our own log lines are the ones reviewed for document content.
    for library in ("httpx", "httpcore", "python_multipart", "multipart"):
        logging.getLogger(library).setLevel(logging.WARNING)
    # structlog's own loggers, if a module uses them, end in the same handler.
    structlog.configure(
        processors=[*_PRE_CHAIN, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    return handler
