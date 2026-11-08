"""CLI. Run from apps/ai, where the key is configured: `pnpm eval:run smoke --repeats 3`.

No argument is a path (SonarCloud treats a path from the command line as tainted, T4.1b): the
dataset, the runs file and the report names are derived from the configuration.
"""

import argparse
import json
import re
import secrets
import sys

from app.config import Settings
from app.providers import build_provider
from app.services.extract import PROMPT_VERSION
from runner import report
from runner.dataset import REPO, SPLITS, DatasetError, load
from runner.run import read_records, run_split

RUNS_DIR = REPO / "eval" / "runs"  # git-ignored: holds the values the model read
REPORTS_DIR = REPO / "eval" / "reports"
SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")


def settings() -> Settings:
    # The runner serves nothing: Settings requires the service token, this process never uses it.
    return Settings(ai_service_token=secrets.token_hex(16))


def slug(dataset: str, model: str) -> str:
    name = f"{dataset}-{model}-{PROMPT_VERSION.replace('/', '-')}"
    if not SLUG.fullmatch(name):
        raise SystemExit("model or prompt name is not a safe file name")
    return name


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval", description="Extraction eval (T4.3)")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="call the model on one split")
    run.add_argument("split", choices=SPLITS)
    run.add_argument("--repeats", type=int, default=1, choices=range(1, 6))
    run.add_argument("--rpm", type=int, default=10, choices=range(1, 31))
    run.add_argument("--max-calls", type=int, default=150, choices=range(1, 451))
    sub.add_parser("report", help="write eval/reports from the recorded runs")
    args = parser.parse_args(argv)

    config = settings()
    if config.llm_provider == "fake":
        raise SystemExit("LLM_PROVIDER=fake gives canned answers: its report would measure nothing")
    try:
        dataset = load()
    except DatasetError as err:
        print(f"dataset check failed: {err}", file=sys.stderr)
        return 1
    name = slug(dataset.name, config.llm_model)
    runs = RUNS_DIR / f"{name}.jsonl"
    if args.command == "run":
        provider = build_provider(config)
        print(f"split={args.split} repeats={args.repeats} model={provider.model}", flush=True)
        complete = run_split(
            dataset,
            args.split,
            args.repeats,
            provider,
            runs,
            rpm=args.rpm,
            max_calls=args.max_calls,
            say=lambda line: print(line, flush=True),
        )
        return 0 if complete else 2
    built = report.build(read_records(runs), dataset)
    REPORTS_DIR.mkdir(exist_ok=True)
    (REPORTS_DIR / f"{name}.json").write_text(
        json.dumps(built, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (REPORTS_DIR / f"{name}.md").write_text(report.to_markdown(built), encoding="utf-8")
    print(f"wrote eval/reports/{name}.json and .md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
