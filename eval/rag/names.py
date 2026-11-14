"""Fixed paths. No path comes from the command line (SonarCloud treats one as tainted, T4.1b)."""

from pathlib import Path

RAG_DIR = Path(__file__).resolve().parent
EVAL_DIR = RAG_DIR.parent
GOLDEN_FILE = RAG_DIR / "golden-v1.json"
JUDGE_PROMPT = RAG_DIR / "prompts" / "rag_judge_v1.md"
JUDGE_PROMPT_VERSION = "rag_judge/v1"
HAND_LABELS = RAG_DIR / "hand-labels-v1.json"
DATASET_DIR = EVAL_DIR / "datasets" / "v1" / "documents"
# Runs hold the synthetic text the models read and wrote: git-ignored, like eval/runs of T4.3.
RUNS_DIR = EVAL_DIR / "runs" / "rag"
ANSWERS_FILE = RUNS_DIR / "answers.jsonl"
JUDGEMENTS_FILE = RUNS_DIR / "judgements.jsonl"
# A judge run set aside (best-effort decoding broke the schema): not scored, but its calls count.
DISCARDED_JUDGEMENTS_FILE = RUNS_DIR / "judgements-best-effort.jsonl"
HAND_SHEET = RUNS_DIR / "hand-sheet.md"
TOKENS_FILE = RUNS_DIR / "tokens.json"
REPORTS_DIR = EVAL_DIR / "reports"
REPORT_NAME = "rag-v1"
