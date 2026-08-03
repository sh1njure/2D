import { useState } from "react";
import type { Demo, LiveStat, SlotFrame } from "../lib/demo";
import { WeaponIcon } from "../lib/weapons";

interface Props {
  demo: Demo;
  frame: SlotFrame[] | null;
  slots: string[];
  live: Map<string, LiveStat>;
}

interface Row {
  sid: string;
  name: string;
  team: "A" | "B";
  hp: number;
  alive: boolean;
  weapon: string | null;
  money: number;
  st: LiveStat;
  adr: number;
  hs: number;
}

function hpColor(hp: number): string {
  if (hp > 60) return "var(--ct)";
  if (hp > 25) return "var(--t)";
  return "var(--live)";
}

// One compact row per player; all ten fit without scrolling. Click to expand.
function PlayerRow({ r }: { r: Row }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded px-2 py-1 text-left hover:bg-raised/60 ${
          r.alive ? "" : "opacity-45"
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-sm ${r.alive ? "text-ink" : "text-muted line-through"}`}>
              {r.name}
            </span>
            {!r.alive && <span className="text-[10px] text-live">dead</span>}
          </div>
          {/* hp bar */}
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-grid">
            <div
              className="h-full rounded-full"
              style={{ width: `${r.alive ? r.hp : 0}%`, background: hpColor(r.hp) }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex w-11 justify-end">
            <WeaponIcon name={r.weapon} h={15} />
          </span>
          <span className="num w-16 text-right text-xs tabular-nums">
            <span className="text-ink">{r.st.kills}</span>
            <span className="text-muted">/{r.st.deaths}/{r.st.assists}</span>
          </span>
          <span className="num w-12 text-right text-xs tabular-nums text-muted">${r.money}</span>
        </div>
      </button>
      {open && (
        <div className="num mx-2 mb-1 grid grid-cols-3 gap-1 rounded bg-bg/60 px-2 py-1 text-[11px] text-muted">
          <span>HP {r.alive ? r.hp : 0}</span>
          <span>ADR {r.adr}</span>
          <span>HS {r.hs}</span>
          <span className="col-span-3 truncate">{r.weapon ?? "—"}</span>
        </div>
      )}
    </li>
  );
}

export function Scoreboard({ demo, frame, slots, live }: Props) {
  const rows: Row[] = demo.players.map((p) => {
    const i = slots.indexOf(p.steamid);
    const sf = i >= 0 ? frame?.[i] : undefined;
    const wIdx = sf ? sf[6] : -1;
    return {
      sid: p.steamid,
      name: p.name,
      team: p.team_label,
      hp: sf ? sf[4] : 100,
      alive: sf ? !!sf[5] : true,
      weapon: wIdx >= 0 ? (demo.positions?.weapon_table[wIdx] ?? null) : null,
      money: sf ? sf[7] : 0,
      st: live.get(p.steamid) ?? { kills: 0, deaths: 0, assists: 0 },
      adr: p.adr,
      hs: p.hs_kills,
    };
  });
  const byTeam = (t: "A" | "B") =>
    rows.filter((r) => r.team === t).sort((a, b) => b.st.kills - a.st.kills);

  const aliveCount = (t: "A" | "B") => byTeam(t).filter((r) => r.alive).length;

  const Team = ({ t, side, color }: { t: "A" | "B"; side: string; color: string }) => (
    <div>
      <div className="flex items-center justify-between px-2 py-1">
        <span className={`display flex items-center gap-1.5 text-xs uppercase tracking-wide ${color}`}>
          <span>●</span> Team {t} · {side}
        </span>
        <span className="num text-[11px] text-muted">{aliveCount(t)} alive</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] px-2 pb-0.5 text-[9px] uppercase text-muted">
        <span>player · hp</span>
        <span className="flex gap-2.5">
          <span className="w-11" />
          <span className="w-16 text-right">K / D / A</span>
          <span className="w-12 text-right">money</span>
        </span>
      </div>
      <ul>
        {byTeam(t).map((r) => (
          <PlayerRow key={r.sid} r={r} />
        ))}
      </ul>
    </div>
  );

  return (
    <div className="space-y-2">
      <Team t="A" side="started T" color="text-t" />
      <Team t="B" side="started CT" color="text-ct" />
    </div>
  );
}
