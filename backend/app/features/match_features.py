"""Feature layer: parsed demo (out.json) -> compact, team-scoped JSON for the LLM.

Why this exists (see CLAUDE.md §7 "AI"): we never send raw ticks to the model.
The parser produces detailed events; this module aggregates them into a small
(~4-6k-token) JSON of *facts and observations* about ONE chosen team. The model
narrates that JSON; it does not do the counting. Keeping the aggregation here (in
plain Python/SQL-style passes) makes every number the model sees traceable and
testable, and keeps pattern-finding out of the model.

Team perspective: the caller picks team "A" or "B" (players choose which team to
analyse). All rates are computed from that team's point of view.

Side-per-round is DERIVED FROM DATA, not from assumed MR12/overtime switch rules:
for each round we see which team's score incremented (the winner) and the round's
`winner_side`, which pins both teams' sides for that round without guessing.

FEATURE_VERSION: bump when the emitted schema changes (auditability / retrying an
analysis against a known feature shape).
"""

from __future__ import annotations

from typing import Any

FEATURE_VERSION = 2

# Utility thrown to ~the same spot this many times (or more) by the same player
# counts as a recurring-usage pattern. Location is bucketed to a coarse grid.
UTIL_PATTERN_MIN = 3
UTIL_GRID = 256  # game units; ~a small area / callout-sized bucket
# A player who loses the opening duel at least this many times is a repeat entry.
FIRST_DEATH_MIN = 3

# A trade kill: attacker avenges a just-killed teammate. 5s window at the demo's
# tickrate. Kept here (not the parser) because it's a feature-layer judgement.
TRADE_WINDOW_SECONDS = 5.0

# Multikill buckets we report (a "3k" round etc.).
MULTIKILL_LABELS = {2: "2k", 3: "3k", 4: "4k", 5: "5k"}


def _sid_index(demo: dict) -> dict[str, dict]:
    """steamid -> player summary dict."""
    return {p["steamid"]: p for p in demo["players"]}


def _team_of(demo: dict) -> dict[str, str]:
    """steamid -> 'A' | 'B'."""
    return {p["steamid"]: p["team_label"] for p in demo["players"]}


def _round_sides(demo: dict) -> dict[int, dict[str, str]]:
    """Per round number -> {'A': 'T'|'CT', 'B': 'T'|'CT'}.

    Derived from data: the team whose score increased this round is the winner,
    and `winner_side` says which side won, which fixes both teams' sides. No
    dependency on half-length or overtime rules.
    """
    out: dict[int, dict[str, str]] = {}
    prev = {"A": 0, "B": 0}
    for r in demo["rounds"]:
        after = r["score_after"]
        won_a = after["A"] > prev["A"]
        winner_side = r["winner_side"]  # 'T' | 'CT' | '?'
        other = "CT" if winner_side == "T" else "T"
        if winner_side in ("T", "CT"):
            winner_team = "A" if won_a else "B"
            loser_team = "B" if won_a else "A"
            out[r["number"]] = {winner_team: winner_side, loser_team: other}
        else:
            # Unknown winner side (shouldn't happen for live rounds); leave blank.
            out[r["number"]] = {"A": "?", "B": "?"}
        prev = after
    return out


def _fmt_clock(freeze_end_tick: int, tick: int, tickrate: int) -> str:
    rate = tickrate if tickrate > 0 else 64
    sec = max(0, (tick - freeze_end_tick) / rate)
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def build_features(demo: dict, team: str) -> dict[str, Any]:
    """Aggregate a parsed demo into the team-scoped feature JSON.

    `team` is 'A' or 'B'. Returns a plain dict (JSON-serialisable).
    """
    if team not in ("A", "B"):
        raise ValueError(f"team must be 'A' or 'B', got {team!r}")

    match = demo["match"]
    opp = "B" if team == "A" else "A"
    tickrate = int(match.get("tickrate") or 64)
    trade_ticks = int(TRADE_WINDOW_SECONDS * tickrate)

    sid_team = _team_of(demo)
    sid_info = _sid_index(demo)
    sides = _round_sides(demo)

    team_sids = set(match["teams"][team]["players"])
    # Some POV/noisy demos may list a steamid in players[] not present in teams[];
    # fall back to team_label so we never silently drop a player.
    team_sids |= {sid for sid, lbl in sid_team.items() if lbl == team}

    # --- per-player aggregates (from the parser's match summary + event passes) --
    players_out: list[dict] = []
    for sid in match["teams"][team]["players"]:
        p = sid_info.get(sid)
        if not p:
            continue
        deaths = p["deaths"]
        kd = round(p["kills"] / deaths, 2) if deaths else float(p["kills"])
        hs_pct = round(100 * p["hs_kills"] / p["kills"]) if p["kills"] else 0
        players_out.append(
            {
                "name": p["name"],
                "kills": p["kills"],
                "deaths": p["deaths"],
                "assists": p["assists"],
                "kd": kd,
                "adr": p["adr"],
                "hs_pct": hs_pct,
                # filled in the round walk below:
                "opening_kills": 0,
                "opening_deaths": 0,
                "multikill_rounds": {},
                "trade_kills": 0,
                "flashes_thrown": 0,
                "enemies_flashed": 0,
                "he_thrown": 0,
                "molotov_thrown": 0,
                "smoke_thrown": 0,
            }
        )
    pout_by_name = {po["name"]: po for po in players_out}

    def po(sid: str | None) -> dict | None:
        if not sid:
            return None
        p = sid_info.get(sid)
        return pout_by_name.get(p["name"]) if p else None

    # --- match + per-round aggregates -------------------------------------------
    rounds_out: list[dict] = []
    # side split: rounds played/won on each side (team perspective)
    side_split = {"T": {"played": 0, "won": 0}, "CT": {"played": 0, "won": 0}}
    # buy-type outcomes (team perspective): played/won per buy category
    buy_split: dict[str, dict[str, int]] = {}
    opening_won = 0
    opening_total = 0
    plants = 0
    defuses = 0
    team_kills_total = 0
    opp_kills_total = 0

    for r in demo["rounds"]:
        n = r["number"]
        side = sides[n][team]
        opp_side = sides[n][opp]
        won = (r["winner_side"] == side) and side in ("T", "CT")

        if side in ("T", "CT"):
            side_split[side]["played"] += 1
            if won:
                side_split[side]["won"] += 1

        team_buy = r["buy"].get(side, "?")
        opp_buy = r["buy"].get(opp_side, "?")
        bs = buy_split.setdefault(team_buy, {"played": 0, "won": 0})
        bs["played"] += 1
        if won:
            bs["won"] += 1

        # --- kills: for/against, opening duel, trades, per-round multikills ------
        kills = r["kills"]
        round_kill_count: dict[str, int] = {}  # name -> kills this round (our team)
        kills_for = 0
        kills_against = 0
        opening = None

        for k in kills:
            atk, vic = k["attacker"], k["victim"]
            atk_team = sid_team.get(atk) if atk else None
            for_us = atk_team == team

            if k["is_opening_duel"] and opening is None:
                opening_total += 1
                if for_us:
                    opening_won += 1
                    opening = "won"
                    ap = po(atk)
                    if ap:
                        ap["opening_kills"] += 1
                elif sid_team.get(vic) == team:
                    opening = "lost"
                    vp = po(vic)
                    if vp:
                        vp["opening_deaths"] += 1

            if for_us:
                kills_for += 1
                ap = po(atk)
                if ap:
                    round_kill_count[ap["name"]] = round_kill_count.get(ap["name"], 0) + 1
            elif sid_team.get(vic) == team:
                kills_against += 1

        # precise trade pass: a kill by us is a trade if the victim had killed one
        # of our players within the window before this kill.
        team_deaths: list[tuple[int, str]] = [
            (k["tick"], k["attacker"])
            for k in kills
            if sid_team.get(k["victim"]) == team and k["attacker"]
        ]
        for k in kills:
            if sid_team.get(k["attacker"]) != team:
                continue
            vic = k["victim"]
            for dt, killer in team_deaths:
                if killer == vic and 0 <= k["tick"] - dt <= trade_ticks:
                    ap = po(k["attacker"])
                    if ap:
                        ap["trade_kills"] += 1
                    break

        for name, c in round_kill_count.items():
            if c >= 2:
                lab = MULTIKILL_LABELS.get(min(c, 5), "5k")
                mk = pout_by_name[name]["multikill_rounds"]
                mk[lab] = mk.get(lab, 0) + 1

        team_kills_total += kills_for
        opp_kills_total += kills_against

        # --- utility thrown by our team this round ------------------------------
        for u in r["utility"]:
            if sid_team.get(u["player"]) != team:
                continue
            p = po(u["player"])
            if not p:
                continue
            kind = u["kind"]
            if kind == "flash":
                p["flashes_thrown"] += 1
                p["enemies_flashed"] += int(u.get("enemies_flashed") or 0)
            elif kind == "he":
                p["he_thrown"] += 1
            elif kind == "molotov":
                p["molotov_thrown"] += 1
            elif kind == "smoke":
                p["smoke_thrown"] += 1

        # --- bomb ----------------------------------------------------------------
        plant = None
        defuse = None
        for b in r["bomb_events"]:
            if b["kind"] == "planted" and sid_team.get(b["player"]) == team:
                plant = _fmt_clock(r["freeze_end_tick"], b["tick"], tickrate)
                plants += 1
            if b["kind"] == "defused" and sid_team.get(b["player"]) == team:
                defuse = _fmt_clock(r["freeze_end_tick"], b["tick"], tickrate)
                defuses += 1

        rounds_out.append(
            {
                "n": n,
                "side": side,
                "buy": team_buy,
                "opp_buy": opp_buy,
                "won": won,
                "end_reason": r["end_reason"],
                "kills_for": kills_for,
                "kills_against": kills_against,
                "opening": opening,  # 'won' | 'lost' | None
                "plant": plant,
                "defuse": defuse,
            }
        )

    # roll multikill_rounds up into a readable count and drop empties
    for p in players_out:
        mk = p["multikill_rounds"]
        p["multikill_rounds"] = {k: mk[k] for k in ("2k", "3k", "4k", "5k") if k in mk}

    patterns = _compute_patterns(demo, team, sid_team, sid_info, rounds_out, players_out)

    def _wr(d: dict[str, int]) -> dict:
        played, won = d["played"], d["won"]
        return {"played": played, "won": won, "win_pct": round(100 * won / played) if played else 0}

    final = match["score"]
    team_score = final[team]
    opp_score = final[opp]

    features: dict[str, Any] = {
        "feature_version": FEATURE_VERSION,
        "match": {
            "map": match["map"],
            "demo_type": match["demo_type"],
            "tickrate": tickrate,
            "tickrate_assumed": match.get("tickrate_assumed", False),
            "rounds_played": match["rounds_played"],
            "analysed_team": team,
            "opponent_team": opp,
            "result": (
                "win" if team_score > opp_score
                else "loss" if team_score < opp_score
                else "tie"
            ),
            "score": {"team": team_score, "opponent": opp_score},
            "warnings": demo.get("warnings", []),
        },
        "team_summary": {
            "rounds_won": team_score,
            "rounds_lost": opp_score,
            "side_split": {"T": _wr(side_split["T"]), "CT": _wr(side_split["CT"])},
            "buy_type_split": {k: _wr(v) for k, v in sorted(buy_split.items())},
            "opening_duels": {
                "played": opening_total,
                "won": opening_won,
                "win_pct": round(100 * opening_won / opening_total) if opening_total else 0,
            },
            "total_kills": team_kills_total,
            "total_deaths": opp_kills_total,
            "bomb_plants": plants,
            "bomb_defuses": defuses,
        },
        # Patterns are computed HERE (Python), not by the model — the model only
        # narrates them. See _compute_patterns.
        "patterns": patterns,
        "players": sorted(players_out, key=lambda p: p["kills"], reverse=True),
        "rounds": rounds_out,
    }
    return features


def _compute_patterns(
    demo: dict,
    team: str,
    sid_team: dict[str, str],
    sid_info: dict[str, dict],
    rounds_out: list[dict],
    players_out: list[dict],
) -> dict[str, Any]:
    """Find recurring behaviours in the team's play. Pure counting over the parsed
    events — the model never does this. Emits structured facts the prompt turns
    into prose.

    - recurring_utility: same player throwing the same grenade type to ~the same
      spot across many rounds (e.g. the same lurk smoke every round).
    - opening_dependency: how much the round result hinges on winning the opening
      duel (round win% when the team drew first blood vs when it lost it).
    - repeat_first_deaths: players who lose the opening duel repeatedly.
    """
    name_of = {sid: info["name"] for sid, info in sid_info.items()}

    # --- recurring utility (bucketed by player + kind + coarse location) --------
    buckets: dict[tuple[str, str, int, int], int] = {}
    for r in demo["rounds"]:
        for u in r["utility"]:
            if sid_team.get(u["player"]) != team:
                continue
            if u.get("x") is None or u.get("y") is None:
                continue
            gx = round(u["x"] / UTIL_GRID)
            gy = round(u["y"] / UTIL_GRID)
            key = (name_of.get(u["player"], "?"), u["kind"], gx, gy)
            buckets[key] = buckets.get(key, 0) + 1
    recurring: list[dict[str, Any]] = [
        {"player": k[0], "kind": k[1], "count": c}
        for k, c in buckets.items()
        if c >= UTIL_PATTERN_MIN
    ]
    recurring.sort(key=lambda d: d["count"], reverse=True)
    recurring = recurring[:8]

    # --- opening-duel dependency ------------------------------------------------
    won_after_win = won_after_loss = n_win_open = n_loss_open = 0
    for r in rounds_out:
        if r["opening"] == "won":
            n_win_open += 1
            if r["won"]:
                won_after_win += 1
        elif r["opening"] == "lost":
            n_loss_open += 1
            if r["won"]:
                won_after_loss += 1
    opening_dependency = {
        "rounds_won_opening": n_win_open,
        "rounds_lost_opening": n_loss_open,
        "round_win_pct_when_win_opening": round(100 * won_after_win / n_win_open)
        if n_win_open
        else 0,
        "round_win_pct_when_lose_opening": round(100 * won_after_loss / n_loss_open)
        if n_loss_open
        else 0,
    }

    # --- players who repeatedly lose the opening duel ---------------------------
    repeat_first_deaths: list[dict[str, Any]] = [
        {"player": p["name"], "opening_deaths": p["opening_deaths"]}
        for p in players_out
        if p["opening_deaths"] >= FIRST_DEATH_MIN
    ]
    repeat_first_deaths.sort(key=lambda d: d["opening_deaths"], reverse=True)

    return {
        "recurring_utility": recurring,
        "opening_dependency": opening_dependency,
        "repeat_first_deaths": repeat_first_deaths,
    }


def approx_tokens(features: dict) -> int:
    """Rough token estimate of the serialised features (~4 chars/token)."""
    import json

    return len(json.dumps(features, separators=(",", ":"))) // 4
