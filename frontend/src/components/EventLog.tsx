import { useEffect, useRef } from "react";
import type { LogEntry, Round } from "../lib/demo";
import { fmtClock, roundClock } from "../lib/demo";

interface Props {
  entries: LogEntry[];
  round: Round;
  tickrate: number;
  curTick: number;
  onSeek: (tick: number) => void;
}

// Per-event-kind glyph + accent. Kept text-based (no icon deps) but colour-coded.
const GLYPH: Record<string, string> = {
  kill: "✖",
  flash: "✷",
  he: "✸",
  smoke: "◍",
  plant: "◆",
  defuse: "✂",
  explode: "✹",
};

function line(e: LogEntry): { text: string; accent: string } {
  const actorColor = e.actorLabel === "A" ? "text-t" : e.actorLabel === "B" ? "text-ct" : "text-ink";
  switch (e.kind) {
    case "kill":
      return { text: `${e.actor} ▸ ${e.target}`, accent: actorColor };
    case "flash":
    case "he":
    case "smoke":
      return { text: `${e.actor} · ${e.weapon}`, accent: "text-muted" };
    case "plant":
      return { text: `${e.actor} planted`, accent: "text-live" };
    case "defuse":
      return { text: `${e.actor} defused`, accent: "text-ct" };
    default:
      return { text: `bomb detonated`, accent: "text-live" };
  }
}

// A demo-style play-by-play. The entry nearest the playhead is highlighted;
// clicking any entry seeks to it.
export function EventLog({ entries, round, tickrate, curTick, onSeek }: Props) {
  const activeIdx = (() => {
    let idx = -1;
    for (let i = 0; i < entries.length; i++) if (entries[i].tick <= curTick) idx = i;
    return idx;
  })();
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <div className="flex h-full flex-col">
      <div className="display px-3 py-2 text-xs uppercase tracking-wider text-muted">Round log</div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {entries.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted">No events yet this round.</div>
        )}
        <ul className="space-y-0.5">
          {entries.map((e, i) => {
            const { text, accent } = line(e);
            const active = i === activeIdx;
            const past = e.tick <= curTick;
            return (
              <li key={i}>
                <button
                  ref={active ? activeRef : undefined}
                  onClick={() => onSeek(e.tick)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] transition-colors ${
                    active ? "bg-raised" : "hover:bg-surface"
                  } ${past ? "opacity-100" : "opacity-45"}`}
                >
                  <span className="num w-9 shrink-0 text-[11px] text-muted">
                    {fmtClock(roundClock(round, e.tick, tickrate))}
                  </span>
                  <span className={`w-3 shrink-0 text-center ${accent}`}>{GLYPH[e.kind]}</span>
                  <span className={`truncate ${accent}`}>{text}</span>
                  {e.kind === "kill" && (
                    <span className="num ml-auto shrink-0 text-[10px] text-muted">
                      {e.headshot ? "hs " : ""}
                      {e.weapon?.replace("weapon_", "")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
