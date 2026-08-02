import type { Round } from "../lib/demo";

interface Props {
  rounds: Round[];
  selected: number; // round number
  onSelect: (roundNumber: number) => void;
}

const REASON_SHORT: Record<string, string> = {
  bomb_exploded: "boom",
  bomb_defused: "defuse",
  ct_elimination: "ct elim",
  t_elimination: "t elim",
  time_expired: "time",
};

// Left rail: every round as a compact row. Winner side tints the marker; the
// active round gets the ember. Numbers are tabular so the score column is calm.
export function RoundRail({ rounds, selected, onSelect }: Props) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="display sticky top-0 bg-surface px-3 py-2 text-xs uppercase tracking-wider text-muted">
        Rounds
      </div>
      <ul>
        {rounds.map((r) => {
          const active = r.number === selected;
          const sideColor = r.winner_side === "CT" ? "bg-ct" : "bg-t";
          return (
            <li key={r.number}>
              <button
                onClick={() => onSelect(r.number)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                  active ? "bg-raised" : "hover:bg-surface"
                }`}
                aria-current={active}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${sideColor}`}
                  style={active ? { boxShadow: "0 0 0 2px var(--live)" } : undefined}
                />
                <span className="num w-6 text-muted">{r.number}</span>
                <span className="num w-10 tabular-nums text-ink">
                  {r.score_after.A}-{r.score_after.B}
                </span>
                <span className="truncate text-xs text-muted">
                  {REASON_SHORT[r.end_reason] ?? r.end_reason}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
