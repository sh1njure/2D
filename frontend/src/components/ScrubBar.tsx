import type { Round } from "../lib/demo";
import { fmtClock, roundClock } from "../lib/demo";

interface Props {
  round: Round;
  frameTicks: number[]; // absolute tick per frame index
  index: number;
  playing: boolean;
  tickrate: number;
  onScrub: (index: number) => void;
  onTogglePlay: () => void;
}

// A demo-style timeline: a track scrubbable by frame, with event ticks marked
// (kills, plant) as notches so you can jump to the action.
export function ScrubBar({
  round,
  frameTicks,
  index,
  playing,
  tickrate,
  onScrub,
  onTogglePlay,
}: Props) {
  const n = frameTicks.length;
  const curTick = frameTicks[index] ?? round.freeze_end_tick;
  const span = round.end_tick - round.freeze_end_tick || 1;

  const notch = (tick: number) =>
    `${(Math.max(0, tick - round.freeze_end_tick) / span) * 100}%`;

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={onTogglePlay}
        className="num shrink-0 w-16 rounded bg-raised px-3 py-1.5 text-sm text-ink hover:bg-grid"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>

      <div className="relative flex-1">
        {/* event notches */}
        <div className="pointer-events-none absolute inset-x-0 -top-2 h-2">
          {round.kills.map((k, i) => (
            <span
              key={`k${i}`}
              className="absolute top-0 h-2 w-px bg-muted"
              style={{ left: notch(k.tick) }}
              title={`kill @ ${fmtClock(roundClock(round, k.tick, tickrate))}`}
            />
          ))}
          {round.bomb_events
            .filter((b) => b.kind === "planted")
            .map((b, i) => (
              <span
                key={`b${i}`}
                className="absolute top-0 h-2 w-0.5 bg-live"
                style={{ left: notch(b.tick) }}
                title="bomb planted"
              />
            ))}
        </div>

        <input
          type="range"
          min={0}
          max={Math.max(0, n - 1)}
          value={index}
          onChange={(e) => onScrub(Number(e.target.value))}
          className="w-full accent-live"
          aria-label="Scrub round timeline"
        />
      </div>

      <div className="num shrink-0 w-14 text-right text-sm text-ink">
        {fmtClock(roundClock(round, curTick, tickrate))}
      </div>
    </div>
  );
}
