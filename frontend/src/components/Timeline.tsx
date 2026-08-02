import type { LogEntry, Round } from "../lib/demo";
import { fmtClock, roundClock } from "../lib/demo";

interface Props {
  round: Round;
  rangeLo: number;
  rangeHi: number;
  playhead: number;
  playing: boolean;
  speed: number;
  tickrate: number;
  markers: LogEntry[];
  onSeek: (tick: number) => void;
  onTogglePlay: () => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [0.5, 1, 2, 4];

// colour + vertical lane per marker kind, so frags/plant/defuse/utility are
// distinguishable at a glance on the track.
function markerStyle(kind: string): { color: string; y: string } {
  switch (kind) {
    case "kill":
      return { color: "var(--ink)", y: "top-0" };
    case "plant":
    case "explode":
      return { color: "var(--live)", y: "top-0" };
    case "defuse":
      return { color: "var(--ct)", y: "top-0" };
    default:
      return { color: "var(--muted)", y: "top-2" }; // utility, lower lane
  }
}

function tip(e: LogEntry, round: Round, tickrate: number): string {
  const t = fmtClock(roundClock(round, e.tick, tickrate));
  if (e.kind === "kill") return `${t} · ${e.actor} ▸ ${e.target}${e.headshot ? " (hs)" : ""}`;
  if (e.kind === "plant") return `${t} · ${e.actor} planted`;
  if (e.kind === "defuse") return `${t} · ${e.actor} defused`;
  if (e.kind === "explode") return `${t} · bomb detonated`;
  return `${t} · ${e.actor} · ${e.weapon}`;
}

// The round timeline the reference lacks entirely: a scrub track with typed,
// clickable, hoverable event markers, plus play/pause and speed.
export function Timeline({
  round,
  rangeLo,
  rangeHi,
  playhead,
  playing,
  speed,
  tickrate,
  markers,
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
        {/* marker lanes */}
        <div className="pointer-events-none absolute inset-x-0 -top-4 h-4">
          {markers.map((m, i) => {
            const s = markerStyle(m.kind);
            return (
              <button
                key={i}
                onClick={() => onSeek(m.tick)}
                title={tip(m, round, tickrate)}
                className={`pointer-events-auto absolute ${s.y} h-2 w-2 -translate-x-1/2 rounded-full border border-bg transition hover:scale-150`}
                style={{ left: pct(m.tick), background: s.color }}
              />
            );
          })}
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
