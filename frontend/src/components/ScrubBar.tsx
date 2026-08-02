import type { Round } from "../lib/demo";
import { fmtClock, roundClock } from "../lib/demo";

interface Props {
  round: Round;
  rangeLo: number; // freeze_end tick
  rangeHi: number; // end tick
  playhead: number; // float tick
  playing: boolean;
  speed: number;
  tickrate: number;
  onSeek: (tick: number) => void;
  onTogglePlay: () => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [0.5, 1, 2, 4];

// Demo-style timeline: scrub by tick (continuous), event notches, play/pause
// and a speed selector. The playhead is a float so playback is smooth.
export function ScrubBar({
  round,
  rangeLo,
  rangeHi,
  playhead,
  playing,
  speed,
  tickrate,
  onSeek,
  onTogglePlay,
  onSpeed,
}: Props) {
  const span = rangeHi - rangeLo || 1;
  const pct = (tick: number) => `${(Math.max(0, tick - rangeLo) / span) * 100}%`;

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onTogglePlay}
        className="num grid h-9 w-9 shrink-0 place-items-center rounded-full bg-live text-bg transition hover:brightness-110"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>

      <div className="relative flex-1">
        <div className="pointer-events-none absolute inset-x-0 -top-2 h-2">
          {round.kills.map((k, i) => (
            <span
              key={`k${i}`}
              className="absolute top-0 h-2 w-px bg-muted/70"
              style={{ left: pct(k.tick) }}
            />
          ))}
          {round.bomb_events
            .filter((b) => b.kind === "planted")
            .map((b, i) => (
              <span
                key={`b${i}`}
                className="absolute top-0 h-2 w-0.5 bg-live"
                style={{ left: pct(b.tick) }}
              />
            ))}
        </div>
        <input
          type="range"
          min={rangeLo}
          max={rangeHi}
          step={1}
          value={Math.round(playhead)}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="w-full accent-live"
          aria-label="Scrub round timeline"
        />
      </div>

      <div className="num w-12 shrink-0 text-right text-sm tabular-nums text-ink">
        {fmtClock(roundClock(round, playhead, tickrate))}
      </div>

      <div className="flex shrink-0 overflow-hidden rounded-md border border-grid">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => onSpeed(s)}
            className={`num px-2 py-1 text-xs transition-colors ${
              speed === s ? "bg-raised text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
