"""File names of a configuration's runs and reports, shared by the CLI and `compare`.

No name comes from the command line (SonarCloud treats a path from argv as tainted, T4.1b): the
model id and the prompt version are checked against a pattern before they become part of a path.
"""

import re

from app.services.extract import PROMPT_VERSION
from runner.dataset import REPO

RUNS_DIR = REPO / "eval" / "runs"  # git-ignored: holds the values the model read
REPORTS_DIR = REPO / "eval" / "reports"
SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")
# An OpenAI-compatible model id may carry its owner and a variant
# ("nvidia/nemotron-3.5-super-vl:free", T4.4): one slash, each part starting with a letter or digit,
# so "../x" or "a//b" are still refused, and at most one ":" variant at the end. Both become "-" in
# a file name.
MODEL = re.compile(
    r"^[a-z0-9][a-z0-9._-]{0,60}(/[a-z0-9][a-z0-9._-]{0,60})?(:[a-z0-9][a-z0-9._-]{0,20})?$"
)


def slug(dataset: str, model: str) -> str:
    if not MODEL.fullmatch(model):
        raise SystemExit("model or prompt name is not a safe file name")
    safe = model.replace("/", "-").replace(":", "-")
    name = f"{dataset}-{safe}-{PROMPT_VERSION.replace('/', '-')}"
    if not SLUG.fullmatch(name):
        raise SystemExit("model or prompt name is not a safe file name")
    return name
