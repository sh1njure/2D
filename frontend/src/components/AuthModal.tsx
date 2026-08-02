import { useState } from "react";

interface Props {
  mode: "signin" | "register";
  onClose: () => void;
}

// Placeholder auth. Accounts, credits and saved matches are Phase 3/5 — there
// is no backend yet, so this collects nothing and submits nothing. It exists to
// show the intended flow; the submit is deliberately disabled and labelled.
export function AuthModal({ mode: initial, onClose }: Props) {
  const [mode, setMode] = useState(initial);
  const isReg = mode === "register";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-grid bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="display text-lg font-semibold">
            {isReg ? "Create account" : "Sign in"}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-muted">
          Preview only — accounts, credits and saved matches arrive in a later phase.
        </p>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-muted">Email</span>
          <input
            type="email"
            disabled
            placeholder="you@example.com"
            className="num w-full rounded-md border border-grid bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 disabled:opacity-70"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-muted">Password</span>
          <input
            type="password"
            disabled
            placeholder="••••••••"
            className="num w-full rounded-md border border-grid bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 disabled:opacity-70"
          />
        </label>

        <button
          disabled
          className="w-full cursor-not-allowed rounded-md bg-live/60 px-3 py-2 text-sm font-medium text-bg"
          title="Not available in the preview"
        >
          {isReg ? "Create account" : "Sign in"} · coming soon
        </button>

        <div className="mt-3 text-center text-xs text-muted">
          {isReg ? "Already have an account?" : "New here?"}{" "}
          <button
            onClick={() => setMode(isReg ? "signin" : "register")}
            className="text-ct hover:underline"
          >
            {isReg ? "Sign in" : "Create one"}
          </button>
        </div>
      </div>
    </div>
  );
}
