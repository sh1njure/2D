import { useMemo, useState } from "react";
import type { Demo } from "../lib/demo";
import { analyzeDemo, type AnalysisResult } from "../lib/api";

interface Props {
  demo: Demo;
  onClose: () => void;
}

type State =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "error"; msg: string }
  | { s: "done"; result: AnalysisResult };

// AI match analysis. The model call runs on the backend (the key stays
// server-side); this panel picks a team, fires the request, and renders the
// text with real loading / error / result states.
export function AnalysisPanel({ demo, onClose }: Props) {
  const [team, setTeam] = useState<"A" | "B">("A");
  const [lang, setLang] = useState<"en" | "ru">("ru");
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ s: "idle" });

  const names = useMemo(() => {
    const by = (t: "A" | "B") =>
      demo.players.filter((p) => p.team_label === t).map((p) => p.name);
    return { A: by("A"), B: by("B") };
  }, [demo]);

  const run = async () => {
    setState({ s: "loading" });
    try {
      const result = await analyzeDemo(demo, team, { language: lang, question });
      setState({ s: "done", result });
    } catch (e) {
      setState({ s: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  const asked = question.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-grid bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-grid px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="display text-base font-semibold">AI match analysis</span>
            <span className="rounded bg-live/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-live">
              beta
            </span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>

        {/* team picker + language */}
        <div className="border-b border-grid px-5 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted">Analyse which team?</span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted">Language</span>
              {(["ru", "en"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`rounded px-2 py-0.5 text-[11px] uppercase transition-colors ${
                    lang === l ? "bg-live text-bg" : "text-muted hover:bg-raised"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTeam(t)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  team === t
                    ? t === "A"
                      ? "border-t bg-t/10"
                      : "border-ct bg-ct/10"
                    : "border-grid hover:bg-raised"
                }`}
              >
                <div className={`display text-sm ${t === "A" ? "text-t" : "text-ct"}`}>
                  Team {t} · {t === "A" ? "started T" : "started CT"}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted">
                  {names[t].join(", ") || "—"}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* body: state machine */}
        <div className="min-h-[180px] flex-1 overflow-y-auto px-5 py-4">
          {state.s === "idle" && (
            <div className="flex h-full flex-col gap-3">
              <p className="text-sm text-muted">
                A coach-style breakdown of team {team}: the patterns that decided the match
                (recurring utility, opening-duel dependency, repeat first deaths) and what to
                change. Or ask a specific question below.
              </p>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">
                  Your question <span className="text-muted/60">(optional)</span>
                </span>
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="e.g. Do we throw the same utility every round? What should we practise?"
                  className="w-full resize-none rounded-md border border-grid bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60"
                />
              </label>
              <button
                onClick={run}
                className="self-start rounded-md bg-live px-4 py-2 text-sm font-medium text-bg hover:brightness-110"
              >
                {asked ? "Ask about the match" : "Generate analysis"}
              </button>
            </div>
          )}

          {state.s === "loading" && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-grid border-t-live" />
              <p className="text-sm text-muted">The model is writing the breakdown…</p>
            </div>
          )}

          {state.s === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="max-w-md rounded-lg border border-live/40 bg-live/10 px-4 py-3 text-sm text-ink">
                {state.msg}
              </div>
              <button
                onClick={run}
                className="rounded-md border border-grid px-4 py-2 text-sm hover:bg-raised"
              >
                Try again
              </button>
            </div>
          )}

          {state.s === "done" && (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {state.result.text}
            </div>
          )}
        </div>

        {/* footer: cost/usage on success */}
        {state.s === "done" && (
          <div className="num flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-grid px-5 py-2 text-[11px] text-muted">
            <span>model {state.result.usage.model_id}</span>
            <span>
              in {state.result.usage.input_tokens} · out {state.result.usage.output_tokens}
            </span>
            <span>cost ${state.result.usage.cost_usd.toFixed(4)}</span>
            <span>prompt {state.result.prompt_version}</span>
            <button
              onClick={() => setState({ s: "idle" })}
              className="ml-auto text-ct hover:underline"
            >
              New analysis
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
