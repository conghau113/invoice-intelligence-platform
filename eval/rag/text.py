"""Text rules shared by scoring and the judge: normalization, expected facts, sentences.

Deterministic on purpose: the judge is a model, so everything that can be decided by a rule is
decided here, and the judge only gets the question a rule cannot answer ("does this source say
this?").
"""

import re
import unicodedata

# A thousands separator between digit groups: "61.829.213", "24,973.09", and the no-break spaces
# some locales use. A plain space is not one: "2 146000" is a quantity and an amount.
_THOUSANDS = re.compile(r"(?<=\d)[.,  ](?=\d{3}(?!\d))")
# A decimal comma, written the Vietnamese way for USD: "122,75" (one or two decimals).
_DECIMAL_COMMA = re.compile(r"(?<=\d),(?=\d{1,2}(?!\d))")
_SPACES = re.compile(r"\s+")


def normalize(text: str) -> str:
    """NFC, case folded, separators removed from numbers, spaces collapsed.

    Diacritics are kept: "Tran" is not "Trần", as in the product (full-text and ILIKE keep them).
    """
    out = unicodedata.normalize("NFC", text).casefold()
    out = _DECIMAL_COMMA.sub(".", out)
    previous = None
    while previous != out:  # "61.829.213": each pass removes the separators it can see
        previous = out
        out = _THOUSANDS.sub("", out)
    return _SPACES.sub(" ", out).strip()


def contains(text: str, fact: str) -> bool:
    """`fact` appears in `text` as a whole token sequence: "3505" is not found in "35050" nor in
    "3505.09" (a decimal point between digits joins them), but is in "3505." at a sentence end."""
    needle = re.escape(normalize(fact))
    pattern = rf"(?<!\w)(?<!\d\.){needle}(?!\w)(?!\.\d)"
    return re.search(pattern, normalize(text)) is not None


def facts_found(text: str, groups: list[list[str]]) -> list[bool]:
    """For each group of alternatives: is at least one of them in the text."""
    return [any(contains(text, alt) for alt in group) for group in groups]


_MARKER = re.compile(r"\[(\d+)\]")
# A sentence ends at . ! ? followed by optional markers, then a space or the end. A dot inside a
# number ("1.100.000", "3505.09") is followed by a digit, so it never ends a sentence.
_END = re.compile(r"[.!?](?:\s*\[\d+\])*(?=\s|$)")
_HAS_WORD = re.compile(r"\w")


def sentences(answer: str) -> list[dict[str, object]]:
    """Splits an answer into sentences with the `[n]` markers each one carries.

    A line break also ends a sentence (bullet lists). A marker written right after the end of a
    sentence ("... USD. [1]") belongs to that sentence. Pieces without a word (a lone "[1]") are
    dropped. Known limit: an abbreviation such as "Co. Ltd" splits a sentence in two.
    """
    out: list[dict[str, object]] = []
    for line in answer.splitlines():
        start = 0
        pieces: list[str] = []
        for m in _END.finditer(line):
            pieces.append(line[start : m.end()])
            start = m.end()
        pieces.append(line[start:])
        for piece in pieces:
            cites = [int(n) for n in _MARKER.findall(piece)]
            text = _MARKER.sub("", piece).strip()
            if _HAS_WORD.search(text):
                out.append({"text": piece.strip(), "cites": cites})
    return out
