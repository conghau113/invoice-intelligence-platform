"""The 10 answers labelled by hand, to measure the judge (`pnpm eval:rag:sheet`).

The sample is fixed by a rule before the judge runs: answered lookups of repeat 1, five per
language when there are enough, ordered by a hash of their id (no random source, nothing chosen by
looking at answers or judgements). In the T5.6 run, repeat 1 had exactly 10 answered lookups (4 vi,
6 en), so the sample is all of them and the hash only fixes the order.

The sheet shows the question, the sources and the numbered sentences, never the judge's verdict,
so the person labelling is not anchored on it.

The sheet holds synthetic invoice text and lives in the git-ignored run folder. The labels file is
committed and holds keys, indexes and labels only.
"""

import copy
import hashlib
import json
from pathlib import Path
from typing import Any

from rag.judge import judge_items

SAMPLE_SIZE = 10
VERDICTS = ("supported", "unsupported", "no_claim")


def _order(key: str) -> str:
    return hashlib.sha256(f"t5.6/{key}".encode()).hexdigest()


def select(asks: list[dict[str, Any]], langs: dict[str, str]) -> list[dict[str, Any]]:
    items = judge_items(asks, repeats={1})
    by_lang: dict[str, list[dict[str, Any]]] = {"vi": [], "en": []}
    for item in sorted(items, key=lambda i: _order(i["key"])):
        by_lang[langs[item["key"].split("/")[1]]].append(item)
    half = SAMPLE_SIZE // 2
    picked = by_lang["vi"][:half] + by_lang["en"][:half]
    rest = by_lang["vi"][half:] + by_lang["en"][half:]
    picked += sorted(rest, key=lambda i: _order(i["key"]))[: SAMPLE_SIZE - len(picked)]
    return sorted(picked, key=lambda i: i["key"])


def sheet(items: list[dict[str, Any]]) -> str:
    out = [
        "# Phiếu chấm tay T5.6 (dữ liệu tổng hợp, không commit)",
        "",
        "Với mỗi câu của câu trả lời, ghi vào `eval/rag/hand-labels-v1.json`:",
        "",
        "- `verdict`: `supported` nếu ít nhất một nguồn ghi đủ mọi tên, số, ngày, mã",
        "  trong câu; `unsupported` nếu câu nêu một sự kiện mà không nguồn nào ghi đủ;",
        '  `no_claim` nếu câu chỉ dẫn dắt ("Các mặt hàng gồm:") hoặc nói là không biết.',
        "- `cites`: với mỗi `[n]` câu đó trích, `true` nếu nguồn n ghi đủ sự kiện của câu,",
        "  `false` nếu không.",
        "",
        "Đọc mọi nguồn, không chỉ nguồn được trích. Định dạng số khác nhau vẫn là cùng giá trị",
        "(`61.829.213` = `61829213`). Không có kết quả của judge trong phiếu này, cố ý.",
        "",
    ]
    for item in items:
        p = item["payload"]
        out += [f"## {item['key']}", "", f"**Câu hỏi:** {p['question']}", "", "**Nguồn:**", ""]
        for s in p["sources"]:
            body = s["content"].replace("\n", "\n    ")
            out += [f"- [{s['n']}]", f"    {body}"]
        out += ["", "**Các câu của câu trả lời:**", ""]
        for s in p["sentences"]:
            out.append(f"{s['i']}. {s['text']}  _(trích: {s['cites'] or 'không'})_")
        out.append("")
    return "\n".join(out)


def template(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "description": "T5.6 hand labels (eval/rag/README.md). Keys and labels only, no content.",
        "labelledBy": None,
        "labelledOn": None,
        "samples": [
            {
                "key": item["key"],
                "sentences": [
                    {"i": s["i"], "verdict": None, "cites": {str(n): None for n in s["cites"]}}
                    for s in item["payload"]["sentences"]
                ],
            }
            for item in items
        ],
    }


def read_labels(path: Path) -> list[dict[str, Any]]:
    """Labelled samples only; a sentence left null means the file is not finished."""
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    samples = data.get("samples", [])
    for sample in samples:
        for s in sample["sentences"]:
            if s["verdict"] is None:
                return []
            if s["verdict"] not in VERDICTS:
                raise ValueError(f"{sample['key']} sentence {s['i']}: unknown verdict")
    return samples


def blind(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """The labels as first given, and which sentences were changed after a report.

    A label changed after the labeller saw the judge's verdict is no longer blind. The file keeps
    the first label of each changed sentence under `revisions`, so the blind agreement stays
    reproducible next to the revised one.
    """
    samples = read_labels(path)
    if not samples:
        return [], []
    revisions = json.loads(path.read_text(encoding="utf-8")).get("revisions", [])
    first = copy.deepcopy(samples)
    by_key = {s["key"]: s for s in first}
    revised = []
    for r in revisions:
        sentence = next(
            (s for s in by_key.get(r["key"], {"sentences": []})["sentences"] if s["i"] == r["i"]),
            None,
        )
        if sentence is None:
            raise ValueError(f"revision {r['key']}#{r['i']}: no such labelled sentence")
        if r["blind"]["verdict"] not in VERDICTS:
            raise ValueError(f"revision {r['key']}#{r['i']}: unknown verdict")
        sentence.update(verdict=r["blind"]["verdict"], cites=r["blind"]["cites"])
        revised.append(f"{r['key']}#{r['i']}")
    return first, revised
