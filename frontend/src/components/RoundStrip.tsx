import type { Round } from "../lib/demo";

interface Props {
  rounds: Round[];
  selected: number;
  onSelect: (n: number) => void;
}

// win-reason glyph (consistent with the event log)
const REASON: Record<string, string> = {
  bomb_exploded: "◆",
  bomb_defused: "✂",
  ct_elimination: "✖",
  t_elimination: "✖",
  time_expired: "◷",
};
const REASON_TEXT: Record<string, string> = {
  bomb_exploded: "bomb",
  bomb_defused: "defuse",
  ct_elimination: "frags",
  t_elimination: "frags",
  time_expired: "time",
};

// Standard MR12 side switches: after round 12, then every 6 in overtime.
function isSwitchBefore(n: number): boolean {
  return n === 13 || (n > 24 && (n - 25) % 6 === 0);
}

// A round ribbon: one chip per round, tinted by the winning side, a reason
// glyph, a visible gap at side switches, and the running score under the strip.
export function RoundStrip({ rounds, selected, onSelect }: Props) {
  const sel = rounds.find((r) => r.number === selected);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1">
        {rounds.map((r) => {
          const ct = r.winner_side === "CT";
          const active = r.number === selected;
          return (
            <div key={r.number} className="flex">
              {isSwitchBefore(r.number) && <div className="mx-1 w-px self-stretch bg-grid" />}
              <button
                onClick={() => onSelect(r.number)}
                title={`Round ${r.number} · ${REASON_TEXT[r.end_reason] ?? r.end_reason} · ${r.score_after.A}-${r.score_after.B}`}
                className={`relative grid h-7 w-7 place-items-center rounded text-[11px] transition ${
                  ct ? "bg-ct/20 text-ct" : "bg-t/20 text-t"
                } ${active ? "ring-2 ring-live" : "hover:brightness-125"}`}
              >
                <span className="num leading-none">{r.number}</span>
                <span className="absolute -bottom-0.5 right-0.5 text-[7px] opacity-80">
                  {REASON[r.end_reason] ?? ""}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {sel && (
        <div className="num flex items-center justify-between px-0.5 text-xs text-muted">
          <span>
            after R{sel.number}: <span className="text-t">{sel.score_after.A}</span>
            <span className="mx-1">–</span>
            <span className="text-ct">{sel.score_after.B}</span>
          </span>
          <span className="uppercase tracking-wide">
            won by{" "}
            <span className={sel.winner_side === "CT" ? "text-ct" : "text-t"}>{sel.winner_side}</span>
          </span>
        </div>
      )}
    </div>
  );
}
