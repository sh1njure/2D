"""Tests for the analysis client's message building + cost math. No live API call
is made here — build_user_message and _cost_usd are pure, and the anthropic SDK is
imported lazily only inside run_analysis."""

from __future__ import annotations

from app.analysis import client


def _features() -> dict:
    return {"match": {"analysed_team": "A"}, "patterns": {}, "rounds": []}


def test_user_message_default_is_full_analysis_en():
    msg = client.build_user_message(_features())
    assert "post-match analysis" in msg
    assert "in English" in msg
    assert "team A" in msg


def test_user_message_russian():
    msg = client.build_user_message(_features(), language="ru")
    assert "in Russian" in msg


def test_user_message_question_mode():
    msg = client.build_user_message(
        _features(), language="ru", question="Кидаем ли мы одну и ту же утилиту?"
    )
    assert "Answer this question" in msg
    assert "in Russian" in msg
    assert "одну и ту же" in msg  # the question text is passed through
    assert "post-match analysis" not in msg  # not the full-analysis instruction


def test_user_message_blank_question_falls_back_to_analysis():
    msg = client.build_user_message(_features(), question="   ")
    assert "post-match analysis" in msg


def test_cost_usd_matches_price_config(monkeypatch):
    monkeypatch.setenv("PRICE_INPUT_PER_MTOK", "1.00")
    monkeypatch.setenv("PRICE_OUTPUT_PER_MTOK", "5.00")
    monkeypatch.setenv("PRICE_CACHED_INPUT_PER_MTOK", "0.10")
    # 1000 fresh input + 2000 output = (1000*1 + 2000*5)/1e6 = 0.011
    assert client._cost_usd(1000, 0, 0, 2000) == round(11000 / 1_000_000, 6)
    # cached reads priced at the cheap rate
    assert client._cost_usd(0, 0, 1000, 0) == round(100 / 1_000_000, 6)
