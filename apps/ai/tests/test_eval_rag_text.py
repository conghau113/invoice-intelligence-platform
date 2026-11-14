"""RAG eval text rules (T5.6): how answers are compared with expected facts and cut into sentences.
Both decide scores without a model, so a wrong rule would silently move a metric."""

from rag.text import contains, facts_found, normalize, sentences


def test_numbers_match_whatever_separators_the_model_writes() -> None:
    assert contains("Tổng cộng 61.829.213 VND [1]", "61829213")
    assert contains("Total: 24,973.09 USD", "24973.09")
    assert contains("Đơn giá 122,75 USD", "122.75")  # decimal comma, Vietnamese style
    assert contains("total 61 829 213", "61829213")  # no-break spaces


def test_a_number_is_not_found_inside_a_longer_one() -> None:
    assert not contains("35050 USD", "3505")
    assert not contains("3505.09 USD", "3505")
    assert not contains("INV-2674379541", "267437954")
    assert contains("INV-267437954.", "267437954")


def test_a_plain_space_between_numbers_is_kept() -> None:
    # "2 146000" is a quantity next to an amount, not 2,146,000.
    assert normalize("2 146000") == "2 146000"
    assert not contains("2 146000", "2146000")


def test_case_is_ignored_but_diacritics_are_not() -> None:
    assert contains("Người bán: TRẦN VÀ ĐỐI TÁC Tập Đoàn", "Trần và đối tác")
    assert not contains("Tran va doi tac", "Trần và đối tác")


def test_each_fact_group_needs_one_of_its_alternatives() -> None:
    text = "Hoá đơn gồm Dây cáp mạng R4052 [1] và bàn làm việc gỗ [1]."
    assert facts_found(
        text, [["R4052", "Dây cáp mạng"], ["P9825", "Bàn làm việc gỗ"], ["E7319"]]
    ) == [
        True,
        True,
        False,
    ]


def test_sentences_keep_numbers_whole_and_carry_their_markers() -> None:
    answer = (
        "Hoá đơn C26TEA-6411465 có tổng 18.808.470 VND [1]. Người bán là Mai Trần [1][2]. "
        "Đơn giá là 122.75 USD. [3]"
    )
    assert sentences(answer) == [
        {"text": "Hoá đơn C26TEA-6411465 có tổng 18.808.470 VND [1].", "cites": [1]},
        {"text": "Người bán là Mai Trần [1][2].", "cites": [1, 2]},
        {"text": "Đơn giá là 122.75 USD. [3]", "cites": [3]},
    ]


def test_list_lines_are_sentences_and_a_lone_marker_is_dropped() -> None:
    answer = (
        "The invoice includes:\n- Network cable C2081 [1]\n- Interior wall paint D5039 [2]\n[1]"
    )
    got = sentences(answer)
    assert [s["cites"] for s in got] == [[], [1], [2]]
    assert got[0]["text"] == "The invoice includes:"


def test_an_answer_without_markers_has_unmarked_sentences() -> None:
    assert [s["cites"] for s in sentences("Seller is X. Total is 5 USD!")] == [[], []]
