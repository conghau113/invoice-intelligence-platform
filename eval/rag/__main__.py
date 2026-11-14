"""CLI of the RAG evaluation (T5.6). Run from apps/ai, where the model keys are configured:

1. `pnpm eval:rag:run`      (API harness, Testcontainers + the AI service: writes answers.jsonl)
2. `pnpm eval:rag:sheet`    (fixes the 10 hand samples, writes the sheet and the labels template)
3. `pnpm eval:rag:judge`    (LLM-as-judge; RAG_JUDGE_BASE_URL / _API_KEY / _MODEL choose it)
4. `pnpm eval:rag:report`   (eval/reports/rag-v1.{json,md})

`tokens` measures the embedding input of the longest chunks (`countTokens`, Gemini).
No argument is a path (SonarCloud, T4.1b): every file is in rag.names.
"""

import argparse
import json
import secrets
import sys

import httpx
from runner.provider import Pacer, StopRun

from app.config import Settings
from app.services.embed import EMBED_MAX_CHARS
from rag import golden as golden_mod
from rag import hand, judge, report, score
from rag.judge_provider import JudgeConfigError, JudgeSettings, build_judge
from rag.names import (
    ANSWERS_FILE,
    DISCARDED_JUDGEMENTS_FILE,
    EVAL_DIR,
    HAND_LABELS,
    HAND_SHEET,
    JUDGEMENTS_FILE,
    RAG_DIR,
    REPORT_NAME,
    REPORTS_DIR,
    TOKENS_FILE,
)

CORPUS = EVAL_DIR.parent / "apps" / "api" / "test" / "fixtures" / "retrieval" / "corpus.json"
EMBED_MODEL = "gemini-embedding-001"
EMBED_TOKEN_LIMIT = 2048


def settings() -> Settings:
    # Nothing is served: Settings requires the service token, this process never uses it.
    return Settings(ai_service_token=secrets.token_hex(16))


def _asks() -> list[dict]:
    records = score.read_records(ANSWERS_FILE)
    asks = score.latest_asks(records)
    if not asks:
        raise SystemExit(
            f"no answers in {ANSWERS_FILE.relative_to(EVAL_DIR)}: run `pnpm eval:rag:run` first"
        )
    return asks


def _sheet() -> int:
    golden = golden_mod.load()
    langs = {q.id: q.lang for q in golden.questions}
    items = hand.select(_asks(), langs)
    HAND_SHEET.parent.mkdir(parents=True, exist_ok=True)
    HAND_SHEET.write_text(hand.sheet(items), encoding="utf-8")
    if HAND_LABELS.exists():
        print(f"{HAND_LABELS.name} exists: not overwritten")
    else:
        HAND_LABELS.write_text(json.dumps(hand.template(items), indent=2) + "\n", encoding="utf-8")
    print(f"{len(items)} samples: {', '.join(i['key'] for i in items)}")
    print(f"sheet: {HAND_SHEET}")
    return 0


def _judge(args: argparse.Namespace) -> int:
    try:
        provider, host = build_judge(JudgeSettings())
    except JudgeConfigError as err:
        raise SystemExit(str(err)) from None
    asks = _asks()
    items = judge.judge_items(asks, repeats={1} if args.judge_pass == 2 else None)
    done = judge.judged_keys(score.read_records(JUDGEMENTS_FILE))
    # The host only, never the key: shows which service really judges.
    print(
        f"pass={args.judge_pass} judge={provider.model} via {host} "
        f"items={len(items)} rpm={args.rpm}",
        flush=True,
    )
    try:
        calls = judge.run_judge(
            provider,
            items,
            judge_pass=args.judge_pass,
            done=done,
            out=JUDGEMENTS_FILE,
            pacer=Pacer(args.rpm),
            max_calls=args.max_calls,
        )
    except StopRun as stop:
        print(f"stopped: {stop}. Run the same command again later: judged answers are kept.")
        return 1
    print(f"{calls} judge calls")
    return 0


def _tokens() -> int:
    """`countTokens` on the longest chunk texts as /embed sends them (cut at EMBED_MAX_CHARS)."""
    config = settings()
    if config.gemini_api_key is None:
        raise SystemExit("GEMINI_API_KEY is not set")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    texts = sorted(
        (c["content"][:EMBED_MAX_CHARS] for inv in corpus["invoices"] for c in inv["chunks"]),
        key=len,
        reverse=True,
    )[:3]
    out = []
    with httpx.Client(timeout=30) as client:
        for text in texts:
            res = client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:countTokens",
                headers={"x-goog-api-key": config.gemini_api_key.get_secret_value()},
                json={"contents": [{"parts": [{"text": text}]}]},
            )
            if res.status_code != 200:  # never print the body: it may echo the text
                raise SystemExit(f"countTokens answered HTTP {res.status_code}")
            out.append({"chars": len(text), "tokens": res.json()["totalTokens"]})
    result = {
        "model": EMBED_MODEL,
        "cutAt": EMBED_MAX_CHARS,
        "limit": EMBED_TOKEN_LIMIT,
        "chunks": out,
    }
    TOKENS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKENS_FILE.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))
    return 0


def _report() -> int:
    golden = golden_mod.load()
    records = score.read_records(ANSWERS_FILE)
    invoices = {
        f"invoice-{i:04d}": golden_mod.expected_invoice(f"invoice-{i:04d}") for i in range(100)
    }
    scored = score.score_run(golden, records, invoices)
    judgements = score.read_records(JUDGEMENTS_FILE)
    tokens = json.loads(TOKENS_FILE.read_text(encoding="utf-8")) if TOKENS_FILE.exists() else None
    first, revised = hand.blind(HAND_LABELS)
    built = report.build(
        golden,
        scored,
        records,
        judgements,
        hand.read_labels(HAND_LABELS),
        tokens,
        discarded=score.read_records(DISCARDED_JUDGEMENTS_FILE),
        blind_labels=first,
        revised=revised,
    )
    REPORTS_DIR.mkdir(exist_ok=True)
    (REPORTS_DIR / f"{REPORT_NAME}.json").write_text(
        json.dumps(built, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    limits = (RAG_DIR / "judge-limits.md").read_text(encoding="utf-8")
    (REPORTS_DIR / f"{REPORT_NAME}.md").write_text(
        report.to_markdown(built, limits), encoding="utf-8"
    )
    print(f"eval/reports/{REPORT_NAME}.json and .md")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag", description="RAG evaluation (T5.6)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("sheet", help="fix the 10 hand samples, write the sheet and labels template")
    run = sub.add_parser("judge", help="LLM-as-judge over the recorded answers")
    run.add_argument("--pass", dest="judge_pass", type=int, default=1, choices=(1, 2))
    run.add_argument("--rpm", type=int, default=3, choices=range(1, 31))
    run.add_argument("--max-calls", type=int, default=80, choices=range(1, 201))
    sub.add_parser("tokens", help="countTokens of the longest chunks (Gemini, free)")
    sub.add_parser("report", help="write eval/reports/rag-v1.{json,md}")
    args = parser.parse_args(argv)
    if args.command == "sheet":
        return _sheet()
    if args.command == "judge":
        return _judge(args)
    if args.command == "tokens":
        return _tokens()
    return _report()


if __name__ == "__main__":
    sys.exit(main())
