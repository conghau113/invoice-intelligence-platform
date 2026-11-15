"""What an extraction result depends on, for the API's result cache (T6.3, ADR 0013).

The API worker keys a cached extraction by (content hash, model, prompt version, pipeline version)
and asks for these three before it sends a file. `pipelineVersion` is a hash of the code that turns
bytes into an invoice, so changing the image filter or the PDF renderer misses the old results
without anyone remembering to bump a number (Phát sinh T4.1b). The list is the eval gate's
(`eval/runner/gate.py` PIPELINE_FILES); a test keeps the two equal.
"""

import hashlib
from functools import lru_cache
from importlib.metadata import version as installed_version
from pathlib import Path

from app.config import Settings
from app.providers.fake import FakeProvider
from app.services.extract import PROMPT_VERSION

APP_DIR = Path(__file__).resolve().parent.parent

# Relative to apps/ai/app: the Docker image has this directory and not the repo around it.
PIPELINE_FILES = (
    "prompts/invoice_extraction/v1.md",
    "services/extract.py",
    "services/pdf_pages.py",
    "services/image_normalize.py",
    "providers/__init__.py",
    "providers/base.py",
    "providers/gemini.py",
    "providers/openai_compat.py",
    "schemas/generated.py",
    "error_codes.py",
)

# Libraries that turn bytes into the pixels the model sees (PDF render, picture cleaning): a new
# version can change the picture without any file of ours changing (code review T6.3).
RENDER_LIBRARIES = ("pypdfium2",)


def pipeline_hash(root: Path = APP_DIR, libraries: dict[str, str] | None = None) -> str:
    """sha256 over (name, sha256 of the file) in list order, then the installed version of each
    render library. Names are part of it, so moving code from one file to another changes it too."""
    if libraries is None:
        libraries = {name: installed_version(name) for name in RENDER_LIBRARIES}
    outer = hashlib.sha256()
    for name in PIPELINE_FILES:
        outer.update(name.encode("utf-8"))
        outer.update(b"\0")
        outer.update(hashlib.sha256((root / name).read_bytes()).hexdigest().encode("ascii"))
        outer.update(b"\n")
    for name in sorted(libraries):
        outer.update(f"{name}=={libraries[name]}\n".encode())
    return outer.hexdigest()


@lru_cache(maxsize=1)
def _cached_hash() -> str:
    # The code cannot change under a running process; read the files once.
    return pipeline_hash()


def configured_model(settings: Settings) -> str:
    """The model name `usage.model` will carry. The fake provider reports its own name whatever
    LLM_MODEL says; the real adapters report the configured one."""
    if settings.llm_provider == "fake":
        return FakeProvider().model
    return settings.llm_model


def extraction_version(settings: Settings) -> dict[str, str]:
    return {
        "model": configured_model(settings),
        "promptVersion": PROMPT_VERSION,
        "pipelineVersion": _cached_hash(),
    }
