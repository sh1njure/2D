"""Anthropic client for the match analysis step.

Design constraints (CLAUDE.md §2, §7):
  - The API key is the CLIENT's, read from env (ANTHROPIC_API_KEY). Never hardcoded.
  - Model id from env (ANALYSIS_MODEL_ID), default claude-haiku-4-5-20251001.
  - The system prompt is a versioned FILE (prompts/coach_v1.md), not a string here.
  - Prompt caching on the system prompt (it's identical across every job).
  - Output tokens hard-capped (ANALYSIS_MAX_OUTPUT_TOKENS) so a runaway generation
    cannot burn the client's balance.
  - Every call's token usage + computed USD cost is returned to the caller so it can
    be written to the llm_usage ledger ("what did this demo cost us?").
  - Analysis is a separate, retryable step from parsing: this module only turns a
    features dict into text + a usage record. It does no parsing and no DB writes.

This module is import-safe without the `anthropic` package or an API key: the SDK
is imported lazily inside run_analysis, so the feature layer and --dry-run path work
with nothing installed.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001"
DEFAULT_MAX_OUTPUT_TOKENS = 4000
PROMPT_VERSION = "coach_v1"
PROMPTS_DIR = Path(__file__).parent / "prompts"


@dataclass
class Usage:
    """One analysis call's cost record — mirrors the llm_usage ledger columns."""

    model_id: str
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    cost_usd: float


@dataclass
class AnalysisResult:
    text: str
    usage: Usage
    prompt_version: str
    stop_reason: str


class AnalysisError(RuntimeError):
    """Raised for a refusal, an empty key, or an SDK/transport failure."""


def load_system_prompt(version: str = PROMPT_VERSION) -> str:
    path = PROMPTS_DIR / f"{version}.md"
    if not path.exists():
        raise AnalysisError(f"prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def build_user_message(features: dict) -> str:
    """The user turn: a short instruction + the features JSON. All the facts live
    in the JSON; the system prompt says how to write."""
    team = features.get("match", {}).get("analysed_team", "?")
    compact = json.dumps(features, separators=(",", ":"), ensure_ascii=False)
    return (
        f"Write the post-match analysis for team {team}. "
        f"Here is the aggregated match data as JSON:\n\n{compact}"
    )


def _price_config() -> tuple[float, float, float]:
    """(input, output, cached-input) USD per 1M tokens, from env price config."""
    return (
        float(os.getenv("PRICE_INPUT_PER_MTOK", "0.80")),
        float(os.getenv("PRICE_OUTPUT_PER_MTOK", "4.00")),
        float(os.getenv("PRICE_CACHED_INPUT_PER_MTOK", "0.08")),
    )


def _cost_usd(fresh_in: int, cache_write: int, cache_read: int, out_tok: int) -> float:
    """USD for one call from its billed token components.

    fresh_in    - uncached input tokens (full input rate)
    cache_write - tokens written to the cache (billed at the input rate here; a
                  prototype simplification — real ephemeral writes are ~1.25x)
    cache_read  - tokens served from the cache (cheap cached rate)
    out_tok     - output tokens
    """
    p_in, p_out, p_cached = _price_config()
    cost = (
        (fresh_in + cache_write) * p_in + cache_read * p_cached + out_tok * p_out
    ) / 1_000_000
    return round(cost, 6)


def run_analysis(features: dict, *, model_id: str | None = None) -> AnalysisResult:
    """Call the model to narrate `features`. Requires ANTHROPIC_API_KEY in env.

    Raises AnalysisError on missing key, refusal, or transport failure.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise AnalysisError(
            "ANTHROPIC_API_KEY is not set. Set it in the (gitignored) .env, or run "
            "with --dry-run to inspect the features + prompt without an API call."
        )

    resolved_model: str = model_id or os.getenv("ANALYSIS_MODEL_ID") or DEFAULT_MODEL_ID
    max_tokens = int(os.getenv("ANALYSIS_MAX_OUTPUT_TOKENS", str(DEFAULT_MAX_OUTPUT_TOKENS)))

    try:
        import anthropic
    except ImportError as e:  # pragma: no cover - depends on install
        raise AnalysisError(
            "The `anthropic` package is not installed. `pip install anthropic` "
            "(it's in pyproject) or run with --dry-run."
        ) from e

    system_prompt = load_system_prompt()
    client = anthropic.Anthropic(api_key=api_key)

    try:
        resp = client.messages.create(
            model=resolved_model,
            max_tokens=max_tokens,
            # System prompt is identical for every job -> cache it. cache_control on
            # the system block makes repeat jobs read it from cache at the cheap rate.
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": build_user_message(features)}],
        )
    except anthropic.APIError as e:  # pragma: no cover - needs network
        raise AnalysisError(f"Anthropic API call failed: {e}") from e

    if resp.stop_reason == "refusal":
        raise AnalysisError("Model declined to produce an analysis (stop_reason=refusal).")

    # content is a union of block types; only text blocks carry `.text`. getattr
    # keeps this robust (and mypy-clean) across the many non-text block variants.
    text = "".join(
        getattr(block, "text", "")
        for block in resp.content
        if getattr(block, "type", None) == "text"
    )

    u = resp.usage
    cache_read = getattr(u, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(u, "cache_creation_input_tokens", 0) or 0
    # Anthropic reports input_tokens as the non-cached portion; add cache reads and
    # writes so the ledger's input total reflects everything billed as input.
    total_input = u.input_tokens + cache_read + cache_write
    usage = Usage(
        model_id=resolved_model,
        input_tokens=total_input,
        output_tokens=u.output_tokens,
        cached_input_tokens=cache_read,
        cost_usd=_cost_usd(u.input_tokens, cache_write, cache_read, u.output_tokens),
    )
    return AnalysisResult(
        text=text,
        usage=usage,
        prompt_version=PROMPT_VERSION,
        stop_reason=resp.stop_reason or "end_turn",
    )
