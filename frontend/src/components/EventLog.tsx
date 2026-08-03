import { useEffect, useRef } from "react";
import type { LogEntry, Round } from "../lib/demo";
import { fmtClock, roundClock } from "../lib/demo";
import { WeaponIcon } from "../lib/weapons";

interface Props {
  entries: LogEntry[];
  round: Round;
  tickrate: number;
  curTick: number;
  onSeek: (tick: number) => void;
}

// node colour per event kind, driving the rail dot + accents.
function nodeColor(kind: string): string {
  switch (kind) {
    case "kill":
      return "var(--ink)";
    case "he":
    case "molotov":
    case "plant":
    case "explode":
      return "var(--live)";
    case "defuse":
      return "var(--ct)";
    case "flash":
      return "#dfe7ee";
    default:
      return "var(--muted)"; // smoke, decoy
  }
}

function Body({ e }: { e: LogEntry }) {
  const actorColor = e.actorLabel === "A" ? "text-t" : e.actorLabel === "B" ? "text-ct" : "text-ink";
  if (e.kind === "kill") {
    return (
      <span className="truncate">
        <span className={actorColor}>{e.actor}</span>
        <span className="mx-1 text-muted">▸</span>
        <span className="text-muted">{e.target}</span>
        {e.headshot && <span className="ml-1 text-[10px] text-live">hs</span>}
      </span>
    );
  }
  if (e.kind === "plant")
    return (
      <span>
        <span className="text-live">{e.actor}</span> planted the bomb
      </span>
    );
  if (e.kind === "defuse")
    return (
      <span>
        <span className="text-ct">{e.actor}</span> defused
      </span>
    );
  if (e.kind === "explode") return <span className="text-live">bomb detonated</span>;
  return (
    <span className="truncate">
      <span className={actorColor}>{e.actor}</span>
      <span className="ml-1 text-muted">· {e.weapon}</span>
    </span>
  );
}

// Left-side play-by-play with a timeline rail. The event at the playhead is
// highlighted and auto-scrolled; past events are solid, future ones dimmed.
export function EventLog({ entries, round, tickrate, curTick, onSeek }: Props) {
  let activeIdx = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i].tick <= curTick) activeIdx = i;
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="display text-[11px] uppercase tracking-wider text-muted">Round log</span>
        <span className="num text-[10px] text-muted">{entries.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto pb-3">
        {entries.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted">No events yet.</div>
        )}
        {entries.map((e, i) => {
          const active = i === activeIdx;
          const past = e.tick <= curTick;
          const col = nodeColor(e.kind);
          const isNade = ["flash", "he", "smoke", "molotov", "decoy"].includes(e.kind);
          const iconName = e.kind === "kill" ? e.weapon : isNade ? e.weapon : null;
          return (
            <button
              key={i}
              ref={active ? activeRef : undefined}
              onClick={() => onSeek(e.tick)}
              className={`group flex w-full items-stretch gap-2 pr-2 text-left text-[13px] transition-colors ${
                active ? "bg-raised" : "hover:bg-surface/70"
              } ${past ? "opacity-100" : "opacity-40"}`}
              style={active ? { boxShadow: "inset 2px 0 0 var(--live)" } : undefined}
            >
              <span className="num w-10 shrink-0 py-1.5 pl-3 text-right text-[11px] text-muted">
                {fmtClock(roundClock(round, e.tick, tickrate))}
              </span>
              {/* rail */}
              <span className="relative w-3 shrink-0">
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-grid/60" />
                <span
                  className="absolute left-1/2 top-2.5 h-2 w-2 -translate-x-1/2 rounded-full"
                  style={{
                    background: col,
                    boxShadow: active ? `0 0 0 3px color-mix(in srgb, ${col} 25%, transparent)` : undefined,
                  }}
                />
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <Body e={e} />
                </span>
                {iconName && (
                  <span className="shrink-0 text-muted group-hover:text-ink" style={{ color: col }}>
                    <WeaponIcon name={iconName} size={16} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
