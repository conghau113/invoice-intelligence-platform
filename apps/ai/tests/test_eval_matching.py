"""Eval runner (T4.3): normalised comparison and line pairing. No model, no network."""

import unicodedata

import pytest
from runner.matching import accent_only, pair_lines, same

LINE = {
    "description": "Industrial cleaning service H9288",
    "quantity": 4,
    "unit": "visit",
    "unitPrice": 482000,
    "vatRate": 0,
    "amount": 1928000,
}


@pytest.mark.parametrize(
    ("got", "want"),
    [(2, 2.0), (2.5, 2.50), (1100000, 1100000), (0, 0.0), (10, 10.0)],
)
def test_numbers_are_equal_as_decimals_whatever_their_format(got: object, want: object) -> None:
    assert same("number", got, want)


@pytest.mark.parametrize(
    ("got", "want"),
    [(1100001, 1100000), (True, 1), ("1100000", 1100000), (1250, 12.5), (None, 0)],
)
def test_a_different_or_mistyped_number_is_wrong(got: object, want: object) -> None:
    assert not same("number", got, want)


def test_identifiers_ignore_outer_spaces_and_unicode_form_only() -> None:
    assert same("id", " C26TAA ", "C26TAA")
    nfd = unicodedata.normalize("NFD", "HÓA-01")
    assert nfd != "HÓA-01"
    assert same("id", nfd, "HÓA-01")


@pytest.mark.parametrize(
    ("got", "want"),
    [
        ("5193714551", "5193714551-891"),  # branch suffix cut (T3.7): wrong, ADR 0020
        ("c26taa", "C26TAA"),
        ("INV 260403601", "INV-260403601"),
        ("2026-03-02", "2026-03-22"),
    ],
)
def test_identifiers_must_match_as_whole_strings(got: str, want: str) -> None:
    assert not same("id", got, want)


def test_text_ignores_case_punctuation_and_spacing() -> None:
    want = "45553 Alvarez Mountains Suite 958 Taraborough, MT 28187"
    assert same("text", "45553 alvarez mountains\nSuite 958 Taraborough MT  28187", want)
    assert same("text", "Garcia Riley SAMPLE", "Garcia-Riley SAMPLE")


def test_text_with_lost_diacritics_is_wrong_and_reported_as_accent_only() -> None:
    want = "Công ty Đông Á SAMPLE"
    got = "Cong ty Dong A SAMPLE"
    assert not same("text", got, want)
    assert accent_only(got, want)
    assert not accent_only("Công ty Tây Á SAMPLE", want)  # a different word is not "only accents"
    assert not accent_only(want, want)  # right is not an accent error


def test_text_in_another_unicode_form_is_right() -> None:
    want = "Nguyễn Văn Ánh SAMPLE"
    assert same("text", unicodedata.normalize("NFD", want), want)


def test_a_missing_value_equals_only_a_missing_value() -> None:
    assert same("id", None, None)  # an individual buyer has no tax code: null is the answer
    assert not same("id", "0123456789", None)
    assert not same("id", None, "0123456789")
    assert not same("text", "", "x")


def _line(**changes: object) -> dict[str, object]:
    return {**LINE, **changes}


def test_lines_are_paired_by_content_not_by_position() -> None:
    want = [
        _line(description="A4 copy paper P3766", amount=100),
        _line(description="Toner cartridge T221", amount=200),
        _line(description="Office chair C9", amount=300),
    ]
    got = [want[2], want[0], want[1]]
    assert sorted(pair_lines(got, want)) == [(0, 2), (1, 0), (2, 1)]


def test_a_misread_line_still_pairs_and_a_made_up_line_does_not() -> None:
    want = [_line(description="Toner cartridge T221"), _line(description="Office chair C9")]
    misread = _line(description="Toner cartrige T22l", amount=1)  # typo and one wrong column
    invented = {
        "description": "Delivery fee",
        "quantity": 1,
        "unit": "trip",
        "unitPrice": 5,
        "vatRate": 8,
        "amount": 5,
    }
    pairs = pair_lines([invented, misread], want)
    assert pairs == [(1, 0)]  # the chair is missing, the delivery fee is extra


def test_lines_with_the_same_description_are_told_apart_by_their_numbers() -> None:
    want = [_line(amount=100, unitPrice=25), _line(amount=200, unitPrice=50)]
    got = [_line(amount=200, unitPrice=50), _line(amount=100, unitPrice=25)]
    assert sorted(pair_lines(got, want)) == [(0, 1), (1, 0)]


def test_no_lines_pair_with_nothing() -> None:
    assert pair_lines([], [LINE]) == []
    assert pair_lines([LINE], []) == []
