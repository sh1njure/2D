import type { Round } from "../lib/demo";
import { RoundRail } from "./RoundRail";

interface Props {
  rounds: Round[];
  selected: number;
  onSelect: (n: number) => void;
  onAuth: (mode: "signin" | "register") => void;
}

// Tiny inline glyphs so we avoid an icon dependency.
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  { key: "viewer", label: "Viewer", d: "M3 12h18M3 6h18M3 18h18", active: true },
  { key: "matches", label: "My matches", d: "M4 4h16v16H4z M4 9h16", soon: true },
  { key: "upload", label: "Upload demo", d: "M12 16V4m0 0l-4 4m4-4l4 4M4 20h16", soon: true },
];

// Left menu: brand, navigation, account, and the round list. This is the app
// chrome the viewer lives inside.
export function LeftSidebar({ rounds, selected, onSelect, onAuth }: Props) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-grid bg-surface">
      {/* brand */}
      <div className="flex items-center gap-2 px-4 py-3.5">
        <span className="display grid h-7 w-7 place-items-center rounded bg-live/90 text-sm font-bold text-bg">
          2D
        </span>
        <div className="leading-tight">
          <div className="display text-sm font-semibold">CS2 Review</div>
          <div className="text-[10px] text-muted">demo viewer</div>
        </div>
      </div>

      {/* nav */}
      <nav className="px-2">
        {NAV.map((n) => (
          <button
            key={n.key}
            disabled={n.soon}
            aria-current={n.active}
            className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
              n.active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
            } ${n.soon ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <Icon d={n.d} />
            <span>{n.label}</span>
            {n.soon && (
              <span className="ml-auto rounded bg-grid px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
                soon
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mx-3 my-2 border-t border-grid" />

      {/* rounds */}
      <div className="min-h-0 flex-1">
        <RoundRail rounds={rounds} selected={selected} onSelect={onSelect} />
      </div>

      {/* account */}
      <div className="border-t border-grid p-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          <Icon d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0" />
          <span>Guest</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onAuth("signin")}
            className="flex-1 rounded-md border border-grid px-2 py-1.5 text-xs text-ink hover:bg-raised"
          >
            Sign in
          </button>
          <button
            onClick={() => onAuth("register")}
            className="flex-1 rounded-md bg-live px-2 py-1.5 text-xs font-medium text-bg hover:brightness-110"
          >
            Register
          </button>
        </div>
      </div>
    </aside>
  );
}
