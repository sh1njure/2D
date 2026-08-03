#!/usr/bin/env python3
"""Phase 4 prototype: parsed demo (out.json) -> AI match analysis.

Standalone, like scripts/parse_demo.py — no web server, no DB, no queue. It turns
a parsed demo into the team-scoped features JSON and (optionally) narrates it with
the model. This is the piece real users can test before the backend exists.

Usage:
  # Inspect EXACTLY what the model will see — no API call, no key needed:
  python scripts/analyze_demo.py out.json --team A --dry-run

  # Real analysis (needs ANTHROPIC_API_KEY in env / a gitignored .env):
  python scripts/analyze_demo.py out.json --team A

  # Just dump the features JSON (the model input) to a file:
  python scripts/analyze_demo.py out.json --team B --features-out features_B.json

--dry-run is the DEFAULT when no ANTHROPIC_API_KEY is present, so running this
with no key never surprises you with a paid call. Pass --team A or --team B to
choose which team to analyse (players pick their own team).

The .dem is never touched here; this reads only the derived out.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Make `app` importable when run as `python scripts/analyze_demo.py` from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.analysis import client as analysis_client  # noqa: E402
from app.features.match_features import approx_tokens, build_features  # noqa: E402


def _load_env_file(path: Path) -> None:
    """Minimal .env loader so a local run picks up a gitignored .env without a dep.
    Only sets vars that aren't already in the environment. Not a dotenv replacement.
    """
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.split("#", 1)[0].strip()
        if key and key not in os.environ:
            os.environ[key] = val


def _team_label(demo: dict, team: str) -> str:
    t = demo["match"]["teams"][team]
    names = [
        p["name"] for p in demo["players"] if p["team_label"] == team
    ]
    return f"Team {team} (started {t['start_side']}): {', '.join(names) or '—'}"


def main() -> int:
    ap = argparse.ArgumentParser(description="CS2 demo -> AI match analysis (Phase 4 prototype).")
    ap.add_argument("demo_json", help="Path to out.json from scripts/parse_demo.py")
    ap.add_argument("--team", choices=["A", "B"], required=True, help="Which team to analyse")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the features JSON + system prompt and make NO API call.",
    )
    ap.add_argument(
        "--features-out",
        metavar="PATH",
        help="Write the features JSON to PATH (the exact model input).",
    )
    ap.add_argument(
        "--env",
        default=".env",
        help="Path to a .env file to load (default: .env in cwd). Missing is fine.",
    )
    args = ap.parse_args()

    _load_env_file(Path(args.env))

    try:
        demo = json.loads(Path(args.demo_json).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"error: could not read {args.demo_json}: {e}", file=sys.stderr)
        return 2

    if not demo.get("ok", True):
        print("warning: this demo's parse was not ok; analysis may be unreliable.", file=sys.stderr)

    features = build_features(demo, args.team)
    tok = approx_tokens(features)

    fv = features["feature_version"]
    print(f"— {_team_label(demo, args.team)}", file=sys.stderr)
    print(f"— features: ~{tok} tokens, feature_version={fv}", file=sys.stderr)
    for w in features["match"]["warnings"]:
        print(f"— demo warning: {w}", file=sys.stderr)

    if args.features_out:
        Path(args.features_out).write_text(
            json.dumps(features, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"— wrote features to {args.features_out}", file=sys.stderr)

    has_key = bool(os.getenv("ANTHROPIC_API_KEY", "").strip())
    dry = args.dry_run or not has_key

    if dry:
        if not args.dry_run and not has_key:
            print(
                "— no ANTHROPIC_API_KEY found; showing dry-run (features + prompt) "
                "instead of calling the API.",
                file=sys.stderr,
            )
        print("\n===== SYSTEM PROMPT (" + analysis_client.PROMPT_VERSION + ") =====\n")
        print(analysis_client.load_system_prompt())
        print("\n===== USER MESSAGE (features JSON) =====\n")
        print(json.dumps(features, indent=2, ensure_ascii=False))
        return 0

    try:
        result = analysis_client.run_analysis(features)
    except analysis_client.AnalysisError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    u = result.usage
    print(
        f"— model={u.model_id} prompt={result.prompt_version} "
        f"in={u.input_tokens} (cached {u.cached_input_tokens}) out={u.output_tokens} "
        f"cost=${u.cost_usd:.4f} stop={result.stop_reason}",
        file=sys.stderr,
    )
    print("\n===== ANALYSIS =====\n")
    print(result.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
