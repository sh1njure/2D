// Client for the thin analysis test server (backend/app/main.py). The model call
// happens SERVER-SIDE there; this only sends the parsed demo (minus the heavy
// position blob) and the chosen team, and renders whatever comes back.
//
// Base URL is the local dev server by default; override with VITE_API_URL. On the
// static Pages build there is no backend, so calls fail with a clear message.

import type { Demo } from "./demo";

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8000";

export interface AnalysisUsage {
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
}

export interface AnalysisResult {
  text: string;
  prompt_version: string;
  approx_input_tokens: number;
  usage: AnalysisUsage;
}

export interface Health {
  ok: boolean;
  has_key: boolean;
  model_id: string;
}

/** GET /api/health — used to tell the user up front whether a live call is
 *  possible (backend reachable + key present) without spending anything. */
export async function checkHealth(signal?: AbortSignal): Promise<Health> {
  const r = await fetch(`${API_BASE}/api/health`, { signal });
  if (!r.ok) throw new Error(`backend returned ${r.status}`);
  return r.json();
}

/** POST /api/analyze. Strips `positions` from the demo (the server doesn't need
 *  the blob) to keep the request small. Throws Error with a user-readable message. */
export async function analyzeDemo(demo: Demo, team: "A" | "B"): Promise<AnalysisResult> {
  const payload = {
    team,
    demo: {
      match: demo.match,
      players: demo.players,
      rounds: demo.rounds,
      warnings: demo.warnings,
    },
  };
  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // network error / backend not running / blocked by CORS
    throw new Error(
      "Can't reach the analysis server. Start the backend locally " +
        "(uvicorn app.main:app --port 8000). A live analysis needs a running server " +
        "— it can't run on the static preview.",
    );
  }
  if (!r.ok) {
    let detail = `Analysis failed (${r.status}).`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* keep the generic message */
    }
    throw new Error(detail);
  }
  return r.json();
}
