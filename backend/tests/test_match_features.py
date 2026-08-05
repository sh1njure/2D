"""Tests for the AI feature layer (app/features/match_features).

The feature layer feeds the model, so its aggregates must be correct and its
side-per-round derivation must not depend on assumed half/overtime rules. These
tests use a small synthetic demo plus, when present, the real out.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.features.match_features import approx_tokens, build_features

REAL_DEMO = Path(__file__).resolve().parent.parent.parent / "out.json"


def _mk_demo() -> dict:
    """A tiny 4-round, 2v2 demo. A starts T, B starts CT.
    R1 T win (A), R2 CT win (B), R3 T win (A), R4 (after a side switch we DON'T
    model in code) CT win — winner_side pins sides from data regardless.
    """
    a1, a2 = "A1", "A2"
    b1, b2 = "B1", "B2"
    players = [
        {"steamid": a1, "name": "a1", "team_label": "A", "start_side": "T",
         "kills": 5, "deaths": 3, "assists": 1, "hs_kills": 2, "adr": 90.0},
        {"steamid": a2, "name": "a2", "team_label": "A", "start_side": "T",
         "kills": 3, "deaths": 4, "assists": 0, "hs_kills": 0, "adr": 60.0},
        {"steamid": b1, "name": "b1", "team_label": "B", "start_side": "CT",
         "kills": 4, "deaths": 3, "assists": 2, "hs_kills": 1, "adr": 70.0},
        {"steamid": b2, "name": "b2", "team_label": "B", "start_side": "CT",
         "kills": 2, "deaths": 4, "assists": 0, "hs_kills": 0, "adr": 40.0},
    ]

    def rnd(n, start, fe, end, winner_side, reason, sa, buy, kills, bombs=(), util=()):
        return {
            "number": n, "start_tick": start, "freeze_end_tick": fe, "end_tick": end,
            "winner_side": winner_side, "end_reason": reason, "score_after": sa,
            "buy": buy, "kills": list(kills), "bomb_events": list(bombs),
            "utility": list(util),
        }

    def kill(tick, atk, vic, opening=False, hs=False, assist=None):
        return {"tick": tick, "attacker": atk, "victim": vic, "assister": assist,
                "weapon": "ak47", "headshot": hs, "noscope": False,
                "through_smoke": False, "attacker_blind": False,
                "is_opening_duel": opening}

    full = {"T": "full", "CT": "full", "T_value": 4000, "CT_value": 4000}
    rounds = [
        # R1: A (T) wins. A1 opens on B1, then A1 trades... simple.
        rnd(1, 100, 200, 500, "T", "t_elimination", {"A": 1, "B": 0}, full,
            [kill(210, a1, b1, opening=True, hs=True), kill(260, a1, b2)],
            util=[{"kind": "flash", "tick": 205, "player": a1, "x": 0, "y": 0, "z": 0,
                   "enemies_flashed": 2}]),
        # R2: B (CT) wins. B1 opens on A1.
        rnd(2, 600, 700, 900, "CT", "ct_elimination", {"A": 1, "B": 1}, full,
            [kill(710, b1, a1, opening=True), kill(760, b2, a2)]),
        # R3: A (T) wins with a bomb plant.
        rnd(3, 1000, 1100, 1400, "T", "bomb_exploded", {"A": 2, "B": 1}, full,
            [kill(1110, a2, b1, opening=True), kill(1200, a1, b2)],
            bombs=[{"kind": "planted", "tick": 1150, "player": a1, "site_entity": 5}]),
        # R4: B (CT) wins; a trade — b1 kills a1 who had just killed b2.
        rnd(4, 1500, 1600, 1900, "CT", "ct_elimination", {"A": 2, "B": 2}, full,
            [kill(1610, a1, b2, opening=True), kill(1620, b1, a1), kill(1700, b1, a2)]),
    ]

    return {
        "ok": True, "schema_version": 1, "warnings": [],
        "source": {}, "positions": None,
        "match": {
            "map": "de_mirage", "server_name": None, "demo_type": "sourcetv",
            "tickrate": 64, "tickrate_assumed": True, "rounds_played": 4,
            "score": {"A": 2, "B": 2},
            "teams": {"A": {"start_side": "T", "players": [a1, a2]},
                      "B": {"start_side": "CT", "players": [b1, b2]}},
        },
        "players": players, "rounds": rounds,
    }


def test_invalid_team_raises():
    with pytest.raises(ValueError):
        build_features(_mk_demo(), "C")


def test_side_derived_from_data_not_half_rules():
    # R4's winner_side is CT and B won it -> B is CT, A is T in R4, even though a
    # real MR12 match would have switched sides. We derive purely from data.
    f = build_features(_mk_demo(), "A")
    r4 = next(r for r in f["rounds"] if r["n"] == 4)
    assert r4["side"] == "T"        # A is on T in R4 per winner_side derivation
    assert r4["won"] is False


def test_score_and_result_from_team_perspective():
    fa = build_features(_mk_demo(), "A")
    fb = build_features(_mk_demo(), "B")
    assert fa["match"]["score"] == {"team": 2, "opponent": 2}
    assert fa["match"]["result"] == "tie"
    assert fb["match"]["score"] == {"team": 2, "opponent": 2}


def test_a_kills_equal_b_deaths_mirror():
    # A's kills against opponents must equal what B records as deaths, and vice
    # versa — the two perspectives are consistent.
    fa = build_features(_mk_demo(), "A")
    fb = build_features(_mk_demo(), "B")
    assert fa["team_summary"]["total_kills"] == fb["team_summary"]["total_deaths"]
    assert fb["team_summary"]["total_kills"] == fa["team_summary"]["total_deaths"]


def test_opening_duels_counted_once_per_round():
    fa = build_features(_mk_demo(), "A")
    od = fa["team_summary"]["opening_duels"]
    assert od["played"] == 4            # one opening duel per round
    # A won openings in R1 and R3; lost in R2 (B1 opened) and R4 (A opened! wait)
    # R4 opening is a1->b2 => A won it. So A won R1,R3,R4 openings = 3.
    assert od["won"] == 3
    assert od["win_pct"] == 75


def test_trade_kill_detected():
    # R4: b1 kills a1 at 1620, right after a1 killed b2 at 1610 -> that's a trade
    # from B's perspective (b1 avenged b2).
    fb = build_features(_mk_demo(), "B")
    b1 = next(p for p in fb["players"] if p["name"] == "b1")
    assert b1["trade_kills"] >= 1


def test_bomb_plant_attributed_to_planting_team():
    fa = build_features(_mk_demo(), "A")
    assert fa["team_summary"]["bomb_plants"] == 1   # A planted in R3
    fb = build_features(_mk_demo(), "B")
    assert fb["team_summary"]["bomb_plants"] == 0


def test_buy_split_played_sums_to_rounds():
    fa = build_features(_mk_demo(), "A")
    total = sum(v["played"] for v in fa["team_summary"]["buy_type_split"].values())
    assert total == fa["match"]["rounds_played"]


def test_flash_utility_aggregated():
    fa = build_features(_mk_demo(), "A")
    a1 = next(p for p in fa["players"] if p["name"] == "a1")
    assert a1["flashes_thrown"] == 1
    assert a1["enemies_flashed"] == 2


def test_approx_tokens_reasonable():
    f = build_features(_mk_demo(), "A")
    t = approx_tokens(f)
    assert 0 < t < 4000


def test_patterns_opening_dependency():
    # Team A: opening won in R1,R3,R4 (won R1,R3) -> 2/3 = 67%; opening lost in R2
    # (won 0) -> 0%.
    f = build_features(_mk_demo(), "A")
    dep = f["patterns"]["opening_dependency"]
    assert dep["rounds_won_opening"] == 3
    assert dep["rounds_lost_opening"] == 1
    assert dep["round_win_pct_when_win_opening"] == 67
    assert dep["round_win_pct_when_lose_opening"] == 0


def test_patterns_recurring_utility_needs_repetition():
    # The synthetic demo throws one flash once -> below the recurrence threshold.
    f = build_features(_mk_demo(), "A")
    assert isinstance(f["patterns"]["recurring_utility"], list)
    assert f["patterns"]["recurring_utility"] == []


@pytest.mark.skipif(not REAL_DEMO.exists(), reason="real out.json not present")
def test_real_demo_patterns():
    demo = json.loads(REAL_DEMO.read_text())
    for team in ("A", "B"):
        pat = build_features(demo, team)["patterns"]
        # recurring utility entries all clear the min-repeat threshold
        for e in pat["recurring_utility"]:
            assert e["count"] >= 3
            assert e["kind"] in {"flash", "he", "smoke", "molotov", "decoy"}
        # dependency percentages are well-formed
        dep = pat["opening_dependency"]
        assert 0 <= dep["round_win_pct_when_win_opening"] <= 100
        assert 0 <= dep["round_win_pct_when_lose_opening"] <= 100
        # opening won + lost never exceeds rounds played
        assert dep["rounds_won_opening"] + dep["rounds_lost_opening"] <= pat_rounds(demo, team)


def pat_rounds(demo: dict, team: str) -> int:
    return build_features(demo, team)["match"]["rounds_played"]


@pytest.mark.skipif(not REAL_DEMO.exists(), reason="real out.json not present")
def test_real_demo_invariants():
    demo = json.loads(REAL_DEMO.read_text())
    for team in ("A", "B"):
        f = build_features(demo, team)
        rp = f["match"]["rounds_played"]
        # side split covers every round
        ss = f["team_summary"]["side_split"]
        assert ss["T"]["played"] + ss["CT"]["played"] == rp
        # buy split covers every round
        assert sum(v["played"] for v in f["team_summary"]["buy_type_split"].values()) == rp
        # exactly one opening duel per round
        assert f["team_summary"]["opening_duels"]["played"] == rp
        # rounds_won matches the match score for this team
        assert f["team_summary"]["rounds_won"] == f["match"]["score"]["team"]
        # feature JSON stays within the ~4-6k budget the brief targets
        assert approx_tokens(f) < 6000
        # a team's reported total_kills equals the sum of its players' kills
        assert f["team_summary"]["total_kills"] == sum(p["kills"] for p in f["players"])
    # Cross-team: A's kills equal B's deaths MINUS deaths not caused by A
    # (bomb explosions, suicides). So A_kills <= B_deaths, and the gap is exactly
    # the world/suicide deaths on B. We assert the weaker, always-true direction.
    fa, fb = build_features(demo, "A"), build_features(demo, "B")
    assert fa["team_summary"]["total_kills"] <= fb["team_summary"]["total_deaths"]
    assert fb["team_summary"]["total_kills"] <= fa["team_summary"]["total_deaths"]
