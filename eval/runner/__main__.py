"""CLI. Run from apps/ai, where the key is configured: `pnpm eval:run smoke --repeats 3`.

No argument is a path (SonarCloud treats a path from the command line as tainted, T4.1b): the
dataset, the runs file and the report names are derived from the configuration.
"""

import argparse
import json
import secrets
import sys

from app.config import Settings
from app.providers import build_provider
from runner import compare, report
from runner.dataset import SPLITS, Dataset, DatasetError, load
from runner.names import REPORTS_DIR, RUNS_DIR, slug
from runner.run import read_records, run_split


def settings() -> Settings:
    # The runner serves nothing: Settings requires the service token, this process never uses it.
    return Settings(ai_service_token=secrets.token_hex(16))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="eval", description="Extraction eval (T4.3, T4.4)")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="call the model on one split")
    run.add_argument("split", choices=SPLITS)
    run.add_argument("--repeats", type=int, default=1, choices=range(1, 6))
    run.add_argument("--rpm", type=int, default=10, choices=range(1, 31))
    run.add_argument("--max-calls", type=int, default=150, choices=range(1, 451))
    sub.add_parser("report", help="write eval/reports from the recorded runs")
    sub.add_parser("compare", help="write the T4.4 comparison and every compared report")
    return parser


def write_report(dataset: Dataset, model: str) -> str:
    name = slug(dataset.name, model)
    built = report.build(read_records(RUNS_DIR / f"{name}.jsonl"), dataset)
    REPORTS_DIR.mkdir(exist_ok=True)
    (REPORTS_DIR / f"{name}.json").write_text(
        json.dumps(built, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (REPORTS_DIR / f"{name}.md").write_text(report.to_markdown(built), encoding="utf-8")
    return f"eval/reports/{name}.json and .md"


def _run(args: argparse.Namespace, config: Settings, dataset: Dataset) -> int:
    provider = build_provider(config)
    print(f"split={args.split} repeats={args.repeats} model={provider.model}", flush=True)
    complete = run_split(
        dataset,
        args.split,
        args.repeats,
        provider,
        RUNS_DIR / f"{slug(dataset.name, config.llm_model)}.jsonl",
        rpm=args.rpm,
        max_calls=args.max_calls,
        say=lambda line: print(line, flush=True),
    )
    return 0 if complete else 2


def _compare(dataset: Dataset) -> int:
    for config in compare.CONFIGS:
        if read_records(compare.runs_path(dataset, config)):
            print(f"wrote {write_report(dataset, config.model)}")
    for path in compare.write(dataset):
        print(f"wrote {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    config = settings()
    if args.command != "compare" and config.llm_provider == "fake":
        raise SystemExit("LLM_PROVIDER=fake gives canned answers: its report would measure nothing")
    try:
        dataset = load()
    except DatasetError as err:
        print(f"dataset check failed: {err}", file=sys.stderr)
        return 1
    if args.command == "run":
        return _run(args, config, dataset)
    if args.command == "compare":
        return _compare(dataset)
    print(f"wrote {write_report(dataset, config.llm_model)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
