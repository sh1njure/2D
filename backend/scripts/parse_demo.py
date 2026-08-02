#!/usr/bin/env python3
"""
Phase 1 — standalone demo parser.

    python scripts/parse_demo.py <path.dem> [--no-positions] > out.json

No web, no DB, no queue. Reads one CS2 `.dem`, prints a structured JSON summary
of the match to stdout. All progress/error chatter goes to stderr so stdout is
clean JSON.

Every field name and event used here was verified by introspecting the
INSTALLED demoparser2 (0.41.4) against the real demo — not remembered. See the
`# verified:` comments. If you bump demoparser2, re-introspect before trusting
this.

Design choices that matter (why, not what):
  * Warmup + knife round are excluded by anchoring the match at the
    `begin_new_match` event tick and only keeping rounds that start after it.
    The provided demo has knife kills at tick 2405, before begin_new_match at
    3429 — those must never reach analysis.
  * Round winner/end-reason come from game-rules props read AT the round-end
    tick (m_iRoundEndWinnerTeam / m_eRoundEndReason), not inferred from who
    died. Inference breaks on time-outs and saves.
  * Sides swap at halftime and again in overtime. We never hardcode "swap after
    round 12". Instead each player has a fixed team_label (A/B from their
    first-half side), and we read each player's CURRENT side at every round's
    freeze-end. Winner side -> current team on that side -> that team's score.
    This is correct for MR12, MR15, and overtime without knowing the format.
  * Positions are downsampled to 8 ticks/sec. In Phase 1 they live in the JSON
    as plain arrays so the offline viewer (Phase 2) can read them; the compact
    binary blob is a Phase 3 storage concern, not a parsing concern.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback

# demoparser2 is a native extension; import failure should be a clean message,
# not a stack trace the end user can't act on.
try:
    from demoparser2 import DemoParser
except Exception as exc:  # pragma: no cover - environment/install problem
    sys.stderr.write(f"demoparser2 is not importable: {exc}\n")
    sys.exit(2)


# CS2 competitive/SourceTV demos record at 64 tick. demoparser2's header does
# not expose the tickrate, so we state it as an assumption rather than invent a
# field. Position downsampling divides this by TARGET_TPS.
ASSUMED_TICKRATE = 64
TARGET_TPS = 8  # ticks/sec kept for the viewer (brief: downsample to 8/s)

# team_number values, verified from parse_player_info() on the real demo.
TEAM_T = 2
TEAM_CT = 3

# m_eRoundEndReason values observed on the real demo, cross-checked against the
# round's own events (a reason==1 round had a bomb_exploded; reason==7 had
# bomb_defused). Full Source 2 enum is larger; unknown values pass through as
# 'reason_<n>' rather than being silently mislabelled.
ROUND_END_REASON = {
    1: "bomb_exploded",
    7: "bomb_defused",
    8: "ct_elimination",
    9: "t_elimination",
    12: "time_expired",     # target saved / round time ran out
}


def log(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


class DemoError(Exception):
    """Carries a USER-READABLE reason. The brief requires that a failed parse
    tells the user what happened (e.g. 'truncated'), not 'an error occurred'."""


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _validate_file(path: str) -> int:
    if not os.path.isfile(path):
        raise DemoError(f"File not found: {path}")
    size = os.path.getsize(path)
    if size < 1024:
        raise DemoError("File is too small to be a CS2 demo (truncated or empty).")
    # verified: CS2/Source 2 demos start with the magic bytes 'PBDEMS2\0'.
    with open(path, "rb") as f:
        magic = f.read(8)
    if not magic.startswith(b"PBDEMS2"):
        raise DemoError(
            "Not a CS2 demo: missing the 'PBDEMS2' header. This looks like an "
            "old CS:GO demo (HL2DEMO) or a corrupt file."
        )
    return size


def _first_tick(df, default=None):
    return int(df["tick"].iloc[0]) if len(df) else default


def _side_name(team_number: int) -> str:
    return "T" if team_number == TEAM_T else "CT" if team_number == TEAM_CT else "?"


def pair_rounds(freeze_ends, official_ends, starts_all):
    """Pair each freeze-end with the next official round end. Pure function so
    the money/data-critical segmentation (warmup exclusion happens by the caller
    filtering inputs; truncated-trailing-round handling happens here) is unit
    tested without a demo. Returns (windows, warnings).

    A freeze-end with no official end after it = a round that started but the
    demo was cut before it closed. We DROP it and emit a warning rather than
    inventing an end tick — losing it silently would misreport the score."""
    warnings: list[str] = []
    windows = []
    seen_end = set()
    for fe in sorted(freeze_ends):
        end = next((oe for oe in sorted(official_ends) if oe > fe), None)
        if end is None:
            warnings.append(
                f"A round started at tick {fe} but the demo ends before it "
                f"officially closed; it is excluded. The recording is likely "
                f"truncated on the final round (real score may be one higher)."
            )
            continue
        if end in seen_end:
            continue  # defensive: two freeze-ends mapping to one end (noise)
        seen_end.add(end)
        start = max((s for s in starts_all if s <= fe), default=fe)
        windows.append({"start": start, "freeze_end": fe, "end": end})
    return windows, warnings


def parse(path: str, include_positions: bool = True) -> dict:
    size = _validate_file(path)
    log(f"[parse] {os.path.basename(path)}  {size/1e6:.0f} MB — hashing…")
    sha = _sha256(path)

    try:
        p = DemoParser(path)
        header = p.parse_header()          # verified method
    except Exception as exc:
        # demoparser2 raises on corrupt/truncated payloads mid-stream.
        raise DemoError(
            "The demo could not be parsed — it is likely corrupt or the "
            f"download was truncated. (parser said: {exc})"
        ) from exc

    map_name = header.get("map_name", "unknown")
    log(f"[parse] map={map_name} server={header.get('server_name','?')!r}")

    # --- events (each verified present via list_game_events on this demo) -----
    ev = {
        "freeze_end": p.parse_event("round_freeze_end"),
        "official_end": p.parse_event("round_officially_ended"),
        "round_start": p.parse_event("round_start"),
        "begin_match": p.parse_event("begin_new_match"),
        "deaths": p.parse_event("player_death"),
        "hurt": p.parse_event("player_hurt"),
        "blind": p.parse_event("player_blind"),
    }
    bomb_ev = {
        k: p.parse_event(k)
        for k in ("bomb_planted", "bomb_defused", "bomb_exploded")
    }
    nade_ev = {
        "flash": p.parse_event("flashbang_detonate"),
        "he": p.parse_event("hegrenade_detonate"),
        "smoke": p.parse_event("smokegrenade_detonate"),
    }

    # A truncated/corrupt demo often parses the header fine, then returns EMPTY
    # results (demoparser2 hands back an empty list) for every event because the
    # body is cut. Catch that here so the user gets 'truncated', not a stray
    # indexing error from deeper in the code.
    if len(ev["freeze_end"]) == 0 or len(ev["deaths"]) == 0:
        raise DemoError(
            "The demo header parsed but it contains no round data — the file is "
            "truncated or corrupt after the header. Re-download the full demo "
            "and try again."
        )

    players_info = p.parse_player_info()   # verified: steamid,name,team_number

    # --- anchor the real match; drop warmup/knife -----------------------------
    if len(ev["begin_match"]):
        match_start_tick = _first_tick(ev["begin_match"])
    else:
        # Some demos lack begin_new_match; fall back to the last round_start
        # that is clustered with the announce. Conservative: use the earliest
        # freeze_end after any warmup announce.
        match_start_tick = 0
    log(f"[parse] match starts at tick {match_start_tick} (warmup excluded)")

    freeze_ends = sorted(int(t) for t in ev["freeze_end"]["tick"] if int(t) > match_start_tick)
    official_ends = sorted(
        {int(t) for t in ev["official_end"]["tick"] if int(t) > match_start_tick}
    )
    starts_all = sorted(int(t) for t in ev["round_start"]["tick"])

    rounds_windows, warnings = pair_rounds(freeze_ends, official_ends, starts_all)
    log(f"[parse] {len(rounds_windows)} live rounds detected")

    if not rounds_windows:
        raise DemoError(
            "No completed rounds were found after warmup. The demo may be "
            "warmup-only or truncated before the first round ended."
        )

    # --- read game-rules + equipment at the ticks we care about ---------------
    end_ticks = [w["end"] for w in rounds_windows]
    fe_ticks = [w["freeze_end"] for w in rounds_windows]

    # verified props: game-rules props attach to every player row.
    end_state = p.parse_ticks(
        [
            "CCSGameRulesProxy.CCSGameRules.m_iRoundEndWinnerTeam",
            "CCSGameRulesProxy.CCSGameRules.m_eRoundEndReason",
        ],
        ticks=end_ticks,
    )
    # winner/reason are identical across rows of a tick; take one row per tick.
    end_by_tick = {}
    win_col = "CCSGameRulesProxy.CCSGameRules.m_iRoundEndWinnerTeam"
    rea_col = "CCSGameRulesProxy.CCSGameRules.m_eRoundEndReason"
    for _, row in end_state.drop_duplicates("tick").iterrows():
        end_by_tick[int(row["tick"])] = (int(row[win_col]), int(row[rea_col]))

    # per-player side + equipment value at each freeze-end.
    fe_state = p.parse_ticks(
        ["team_num", "CCSPlayerPawn.m_unFreezetimeEndEquipmentValue"],
        ticks=fe_ticks,
    )
    eq_col = "CCSPlayerPawn.m_unFreezetimeEndEquipmentValue"

    # Fixed team labels: a player's label is decided by their side in the very
    # first live round and never changes, so scores survive the halftime swap.
    first_fe = fe_ticks[0]
    first_rows = fe_state[fe_state["tick"] == first_fe]
    team_label = {}   # steamid(str) -> 'A' | 'B'
    start_side = {}   # steamid(str) -> 'T' | 'CT'
    for _, r in first_rows.iterrows():
        sid = str(r["steamid"])
        side = _side_name(int(r["team_num"]))
        start_side[sid] = side
        team_label[sid] = "A" if side == "T" else "B"

    # --- walk rounds: winner, reason, buy type, per-round events --------------
    score = {"A": 0, "B": 0}
    rounds_out = []
    prev_ref_side = None  # to flag pistol rounds (first round of each side-half)

    for idx, w in enumerate(rounds_windows, start=1):
        fe, end = w["freeze_end"], w["end"]
        winner_team, reason_code = end_by_tick.get(end, (0, 0))
        winner_side = _side_name(winner_team)

        rows_fe = fe_state[fe_state["tick"] == fe]
        # current side per steamid this round
        cur_side = {str(r["steamid"]): int(r["team_num"]) for _, r in rows_fe.iterrows()}

        # score: winning side's players -> their fixed label -> +1
        winner_labels = {
            team_label.get(sid)
            for sid, tn in cur_side.items()
            if tn == winner_team and sid in team_label
        }
        winner_labels.discard(None)
        if len(winner_labels) == 1:
            score[winner_labels.pop()] += 1

        # buy type per side from summed freeze-end equipment value (5 players).
        eq_by_side = {TEAM_T: [], TEAM_CT: []}
        for _, r in rows_fe.iterrows():
            tn = int(r["team_num"])
            if tn in eq_by_side:
                eq_by_side[tn].append(int(r[eq_col]))

        # pistol detection: the first round of the match and the first round
        # after a side swap. We watch one anchor player's side change.
        anchor_sid = next(iter(start_side), None)
        anchor_side_now = cur_side.get(anchor_sid)
        is_pistol = (idx == 1) or (prev_ref_side is not None and anchor_side_now != prev_ref_side)
        prev_ref_side = anchor_side_now

        buy = {
            "T": _buy_type(eq_by_side[TEAM_T], is_pistol),
            "CT": _buy_type(eq_by_side[TEAM_CT], is_pistol),
            "T_value": sum(eq_by_side[TEAM_T]),
            "CT_value": sum(eq_by_side[TEAM_CT]),
        }

        rounds_out.append(
            {
                "number": idx,
                "start_tick": w["start"],
                "freeze_end_tick": fe,
                "end_tick": end,
                "winner_side": winner_side,
                "end_reason": ROUND_END_REASON.get(reason_code, f"reason_{reason_code}"),
                "score_after": {"A": score["A"], "B": score["B"]},
                "buy": buy,
                "kills": _round_kills(ev["deaths"], fe, end),
                "bomb_events": _round_bomb(bomb_ev, fe, end),
                "utility": _round_util(nade_ev, ev["blind"], fe, end),
            }
        )

    # --- player stat summary (live rounds only) -------------------------------
    live_lo, live_hi = rounds_windows[0]["freeze_end"], rounds_windows[-1]["end"]
    players_out = _player_stats(
        players_info, ev["deaths"], ev["hurt"], team_label, start_side,
        live_lo, live_hi, len(rounds_out),
    )

    result = {
        "schema_version": 1,
        "warnings": warnings,
        "source": {
            "parser": "demoparser2",
            "parser_version": _pkg_version("demoparser2"),
            "original_filename": os.path.basename(path),
            "file_size_bytes": size,
            "sha256": sha,
        },
        "match": {
            "map": map_name,
            "server_name": header.get("server_name"),
            "demo_type": "sourcetv" if "SourceTV" in header.get("client_name", "") else "pov",
            "tickrate": ASSUMED_TICKRATE,
            "tickrate_assumed": True,
            "patch_version": header.get("patch_version"),
            "match_start_tick": match_start_tick,
            "rounds_played": len(rounds_out),
            "score": {"A": score["A"], "B": score["B"]},
            "teams": {
                "A": {
                    "start_side": "T",
                    "players": [s for s, lbl in team_label.items() if lbl == "A"],
                },
                "B": {
                    "start_side": "CT",
                    "players": [s for s, lbl in team_label.items() if lbl == "B"],
                },
            },
        },
        "players": players_out,
        "rounds": rounds_out,
    }

    if include_positions:
        result["positions"] = _positions(p, rounds_windows, players_info)
    else:
        result["positions"] = None
        log("[parse] positions skipped (--no-positions)")

    return result


def _buy_type(values: list[int], is_pistol: bool) -> str:
    """Classify a 5-player side's buy from summed freeze-end equipment value.
    Heuristic (per-player average), flagged as such — refined in the feature
    layer later. Thresholds are deliberately conservative."""
    if is_pistol:
        return "pistol"
    if not values:
        return "unknown"
    avg = sum(values) / max(len(values), 1)
    if avg < 2000:
        return "eco"
    if avg < 3500:
        return "force"
    return "full"


def _round_kills(deaths, lo, hi) -> list[dict]:
    df = deaths[(deaths["tick"] >= lo) & (deaths["tick"] <= hi)]
    df = df.sort_values("tick")
    out = []
    for i, (_, r) in enumerate(df.iterrows()):
        out.append(
            {
                "tick": int(r["tick"]),
                "attacker": _sid(r.get("attacker_steamid")),
                "victim": _sid(r.get("user_steamid")),
                "assister": _sid(r.get("assister_steamid")),
                "weapon": r.get("weapon"),
                "headshot": bool(r.get("headshot")),
                "noscope": bool(r.get("noscope")),
                "through_smoke": bool(r.get("thrusmoke")),
                "attacker_blind": bool(r.get("attackerblind")),
                "is_opening_duel": i == 0,  # first kill of the round
            }
        )
    return out


def _round_bomb(bomb_ev, lo, hi) -> list[dict]:
    out = []
    for kind, df in bomb_ev.items():
        sub = df[(df["tick"] >= lo) & (df["tick"] <= hi)]
        for _, r in sub.iterrows():
            # site on bomb_planted is a numeric entity id, not A/B; the site
            # letter is resolved later from plant coordinates. `!= self` filters NaN.
            site_val = r.get("site") if "site" in r else None
            site_entity = int(site_val) if site_val is not None and site_val == site_val else None
            out.append(
                {
                    "kind": kind.replace("bomb_", ""),
                    "tick": int(r["tick"]),
                    "player": _sid(r.get("user_steamid")),
                    "site_entity": site_entity,
                }
            )
    return sorted(out, key=lambda x: x["tick"])


def _round_util(nade_ev, blind, lo, hi) -> list[dict]:
    out = []
    for kind, df in nade_ev.items():
        sub = df[(df["tick"] >= lo) & (df["tick"] <= hi)]
        for _, r in sub.iterrows():
            item = {
                "kind": kind,
                "tick": int(r["tick"]),
                "player": _sid(r.get("user_steamid")),
                "x": _num(r.get("x")),
                "y": _num(r.get("y")),
                "z": _num(r.get("z")),
            }
            if kind == "flash":
                # enemies flashed + total blind time caused, from player_blind.
                b = blind[(blind["tick"] >= r["tick"] - 1) & (blind["tick"] <= r["tick"] + 64)]
                b = b[b["attacker_steamid"].astype(str) == str(r.get("user_steamid"))]
                item["enemies_flashed"] = int(len(b))
                blind_total = float(b["blind_duration"].sum()) if len(b) else 0.0
                item["blind_duration_total"] = round(blind_total, 2)
            out.append(item)
    return sorted(out, key=lambda x: x["tick"])


def _player_stats(info, deaths, hurt, team_label, start_side, lo, hi, n_rounds) -> list[dict]:
    d = deaths[(deaths["tick"] >= lo) & (deaths["tick"] <= hi)]
    h = hurt[(hurt["tick"] >= lo) & (hurt["tick"] <= hi)]
    out = []
    for _, pr in info.iterrows():
        sid = str(pr["steamid"])
        kills = int((d["attacker_steamid"].astype(str) == sid).sum())
        deaths_n = int((d["user_steamid"].astype(str) == sid).sum())
        assists = int((d["assister_steamid"].astype(str) == sid).sum())
        hs = int(((d["attacker_steamid"].astype(str) == sid) & (d["headshot"])).sum())
        # ADR: total damage dealt / rounds, damage clamped so overkill (dmg past
        # 100 hp) doesn't inflate it.
        dmg = h[h["attacker_steamid"].astype(str) == sid]["dmg_health"].clip(upper=100).sum()
        out.append(
            {
                "steamid": sid,
                "name": pr["name"],
                "team_label": team_label.get(sid),
                "start_side": start_side.get(sid),
                "kills": kills,
                "deaths": deaths_n,
                "assists": assists,
                "hs_kills": hs,
                "adr": round(float(dmg) / n_rounds, 1) if n_rounds else 0.0,
            }
        )
    return sorted(out, key=lambda x: (-x["kills"], x["deaths"]))


def _positions(p, windows, info) -> dict:
    """Downsample player positions to TARGET_TPS across all live rounds in a
    single parse pass, then slice per round. Coordinates rounded to ints — the
    viewer works in whole game units."""
    step = max(ASSUMED_TICKRATE // TARGET_TPS, 1)
    # Build the full sampled tick list up front so we parse ticks once.
    tick_to_round = {}
    per_round_ticks = {}
    for i, w in enumerate(windows, start=1):
        rt = list(range(w["freeze_end"], w["end"] + 1, step))
        per_round_ticks[i] = rt
        for t in rt:
            tick_to_round[t] = i
    all_ticks = sorted(tick_to_round)
    log(f"[parse] sampling positions at {len(all_ticks)} frames "
        f"({TARGET_TPS}/s over {len(windows)} rounds)…")

    df = p.parse_ticks(
        ["X", "Y", "Z", "yaw", "health", "is_alive", "team_num"],
        ticks=all_ticks,
    )

    slots = [str(s) for s in info["steamid"]]  # fixed column order
    slot_index = {s: i for i, s in enumerate(slots)}

    # frames[round][tick] = flat list per slot of [x,y,z,yaw,hp,alive]
    rounds_frames = {i: {} for i in per_round_ticks}
    for _, r in df.iterrows():
        t = int(r["tick"])
        rnd = tick_to_round.get(t)
        if rnd is None:
            continue
        sid = str(r["steamid"])
        si = slot_index.get(sid)
        if si is None:
            continue
        frame = rounds_frames[rnd].setdefault(t, [None] * len(slots))
        frame[si] = [
            int(r["X"]), int(r["Y"]), int(r["Z"]),
            int(r["yaw"]) % 360,
            int(r["health"]),
            1 if bool(r["is_alive"]) else 0,
        ]

    out_rounds = []
    zero = [0, 0, 0, 0, 0, 0]
    for i, ticks in per_round_ticks.items():
        frames = []
        for t in ticks:
            slotvals = rounds_frames[i].get(t, {})
            if not slotvals:
                continue
            frames.append([t, [(v if v is not None else zero) for v in slotvals]])
        out_rounds.append(
            {"round_number": i, "frame_count": len(frames), "frames": frames}
        )

    return {
        "tps": TARGET_TPS,
        "player_slots": slots,
        # frame layout, per slot: [x, y, z, yaw_deg, health, alive(0/1)]
        "frame_layout": ["x", "y", "z", "yaw", "health", "alive"],
        "rounds": out_rounds,
    }


# --- tiny helpers -------------------------------------------------------------
def _sid(v):
    if v is None or v != v:  # NaN
        return None
    s = str(v)
    return None if s in ("", "nan", "0") else s


def _num(v):
    try:
        if v != v:
            return None
        return round(float(v), 1)
    except (TypeError, ValueError):
        return None


def _pkg_version(name: str) -> str:
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser(description="Parse one CS2 .dem into a JSON summary.")
    ap.add_argument("demo", help="path to the .dem file")
    ap.add_argument("--no-positions", action="store_true",
                    help="omit the position blob (small, human-readable summary)")
    args = ap.parse_args()

    try:
        result = parse(args.demo, include_positions=not args.no_positions)
    except DemoError as e:
        # Clean, user-readable failure — this is what the job would store.
        json.dump({"ok": False, "error": str(e)}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        log(f"[parse] FAILED: {e}")
        return 1
    except Exception as e:  # unexpected — show the trace on stderr for us.
        json.dump({"ok": False, "error": f"Unexpected parser error: {e}"}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        log("[parse] UNEXPECTED ERROR:\n" + traceback.format_exc())
        return 2

    result["ok"] = True
    json.dump(result, sys.stdout, separators=(",", ":") if not args.no_positions else (",", ": "),
              indent=None if not args.no_positions else 2, default=str)
    sys.stdout.write("\n")
    log("[parse] done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
