"""Thin FastAPI app — a TEST server for the AI analysis, not the full Phase 3
backend. It exposes exactly one working feature: take a parsed demo + a chosen
team, run the feature layer + the Anthropic call SERVER-SIDE (the API key never
leaves this process), and return the analysis text + its cost.

Why this exists now: the client wanted to try the analysis "through the site"
before the real backend (upload/queue/DB/accounts) is built. The frontend button
POSTs here so the key stays server-side, which a static Pages bundle can't do.

Run locally:
    cd backend
    uvicorn app.main:app --reload --port 8000
The key is read from backend/.env (gitignored). CORS is open to the Vite dev
origin only.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.analysis import client as analysis_client
from app.features.match_features import approx_tokens, build_features


def _load_env_file(path: Path) -> None:
    """Load backend/.env into os.environ (only keys not already set). Minimal, so
    we don't add a python-dotenv dependency for one file."""
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


_load_env_file(Path(__file__).resolve().parent.parent / ".env")

app = FastAPI(title="CS2 Demo Analysis (test server)", version="0.1.0")

# Only the local Vite dev origin — this test server is not for public deployment.
_origins = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173,http://127.0.0.1:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins.split(",") if o.strip()],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    team: Literal["A", "B"]
    # The parsed demo, minus the heavy position blob. build_features only reads
    # match/players/rounds/warnings, so the frontend strips `positions` before POST.
    demo: dict = Field(..., description="parsed out.json without `positions`")


class Usage(BaseModel):
    model_id: str
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    cost_usd: float


class AnalyzeResponse(BaseModel):
    text: str
    prompt_version: str
    approx_input_tokens: int
    usage: Usage


@app.get("/api/health")
def health() -> dict:
    """Cheap readiness probe. `has_key` lets the UI tell the user up front whether
    a live call is even possible, without spending anything."""
    return {
        "ok": True,
        "has_key": bool(os.getenv("ANTHROPIC_API_KEY", "").strip()),
        "model_id": os.getenv("ANALYSIS_MODEL_ID", analysis_client.DEFAULT_MODEL_ID),
    }


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    try:
        features = build_features(req.demo, req.team)
    except (KeyError, ValueError) as e:
        # malformed demo payload -> user-readable 422
        raise HTTPException(status_code=422, detail=f"Could not read the demo: {e}") from e

    try:
        result = analysis_client.run_analysis(features)
    except analysis_client.AnalysisError as e:
        msg = str(e)
        # Map the common billing rejection to a clear 402 so the UI can say
        # exactly what to do, rather than a generic failure.
        if "credit balance is too low" in msg or "Plans & Billing" in msg:
            raise HTTPException(
                status_code=402,
                detail="The Anthropic account has no credit balance. Add credits in "
                "the Anthropic console (Plans & Billing), then try again.",
            ) from e
        raise HTTPException(status_code=502, detail=msg) from e

    u = result.usage
    return AnalyzeResponse(
        text=result.text,
        prompt_version=result.prompt_version,
        approx_input_tokens=approx_tokens(features),
        usage=Usage(
            model_id=u.model_id,
            input_tokens=u.input_tokens,
            output_tokens=u.output_tokens,
            cached_input_tokens=u.cached_input_tokens,
            cost_usd=u.cost_usd,
        ),
    )
