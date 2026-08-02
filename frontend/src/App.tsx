import { useEffect, useMemo, useRef, useState } from "react";
import type { MapCalibration } from "./lib/coords";
import { worldToRadar } from "./lib/coords";
import type { Demo, PositionRound, SlotFrame } from "./lib/demo";
import { frameIndexForTick, labelBySteamId } from "./lib/demo";
import { RadarCanvas, type KillMark, type RefMark, type UtilMark } from "./components/RadarCanvas";
import { RoundRail } from "./components/RoundRail";
import { ScrubBar } from "./components/ScrubBar";

const CANVAS = 720;

export default function App() {
  const [cal, setCal] = useState<MapCalibration | null>(null);
  const [radarImg, setRadarImg] = useState<HTMLImageElement | null>(null);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roundNo, setRoundNo] = useState(1);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [debug, setDebug] = useState(false);

  // Load calibration + (optional) radar bitmap once we know the map.
  useEffect(() => {
    const map = demo?.match.map ?? "de_inferno";
    fetch(`/maps/${map}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`no calibration for ${map}`))))
      .then(setCal)
      .catch(() => setError(`Missing map calibration for ${map}.`));
    const img = new Image();
    img.onload = () => setRadarImg(img);
    img.onerror = () => setRadarImg(null); // fall back to calibrated grid
    img.src = `/maps/${map}.png`;
  }, [demo?.match.map]);

  // Try to auto-load a bundled sample; otherwise the drop-zone waits.
  useEffect(() => {
    fetch("/demo/sample.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Demo) => setDemo(d))
      .catch(() => {});
  }, []);

  const round = useMemo(
    () => demo?.rounds.find((r) => r.number === roundNo) ?? null,
    [demo, roundNo],
  );
  const posRound: PositionRound | null = useMemo(
    () => demo?.positions?.rounds.find((r) => r.round_number === roundNo) ?? null,
    [demo, roundNo],
  );
  const frameTicks = useMemo(() => posRound?.frames.map((f) => f[0]) ?? [], [posRound]);
  const slots = demo?.positions?.player_slots ?? [];
  const labelBy = useMemo(() => (demo ? labelBySteamId(demo) : new Map()), [demo]);

  // Reset to round start when the round changes.
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [roundNo]);

  // Playback loop at the demo's sampled tps.
  const raf = useRef<number>(0);
  const last = useRef<number>(0);
  useEffect(() => {
    if (!playing || !demo?.positions) return;
    const stepMs = 1000 / demo.positions.tps;
    const tick = (t: number) => {
      if (t - last.current >= stepMs) {
        last.current = t;
        setIndex((i) => {
          if (i + 1 >= frameTicks.length) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, demo, frameTicks.length]);

  const curFrame: SlotFrame[] | null = posRound?.frames[index]?.[1] ?? null;
  const curTick = frameTicks[index] ?? round?.freeze_end_tick ?? 0;

  // Kills up to the current tick, placed at the victim's position at kill time.
  const kills: KillMark[] = useMemo(() => {
    if (!round || !posRound) return [];
    const out: KillMark[] = [];
    for (const k of round.kills) {
      if (k.tick > curTick || !k.victim) continue;
      const slot = slots.indexOf(k.victim);
      if (slot < 0) continue;
      const fi = frameIndexForTick(posRound, k.tick);
      const sf = posRound.frames[fi]?.[1]?.[slot];
      if (sf) out.push({ x: sf[0], y: sf[1], headshot: k.headshot });
    }
    return out;
  }, [round, posRound, slots, curTick]);

  // Utility blooms: visible for ~2s after detonation, fading out.
  const utility: UtilMark[] = useMemo(() => {
    if (!round || !demo) return [];
    const rate = demo.match.tickrate || 64;
    const out: UtilMark[] = [];
    for (const u of round.utility) {
      if (u.x == null || u.y == null) continue;
      const dt = (curTick - u.tick) / rate;
      if (dt < 0 || dt > 2) continue;
      out.push({ x: u.x, y: u.y, kind: u.kind, alpha: 1 - dt / 2 });
    }
    return out;
  }, [round, demo, curTick]);

  // Bomb plant location (once planted this round), at the planter's position.
  const bomb = useMemo(() => {
    if (!round || !posRound) return null;
    const plant = round.bomb_events.find((b) => b.kind === "planted" && b.tick <= curTick);
    if (!plant || !plant.player) return null;
    const slot = slots.indexOf(plant.player);
    if (slot < 0) return null;
    const fi = frameIndexForTick(posRound, plant.tick);
    const sf = posRound.frames[fi]?.[1]?.[slot];
    return sf ? { x: sf[0], y: sf[1] } : null;
  }, [round, posRound, slots, curTick]);

  // Debug overlay reference marks (see computeDebugRefs).
  const refs: RefMark[] = useMemo(
    () => (debug && cal && demo ? computeDebugRefs(cal, demo) : []),
    [debug, cal, demo],
  );

  if (error) return <Centered>{error}</Centered>;
  if (!cal) return <Centered>Loading map calibration…</Centered>;
  if (!demo) return <DropZone onDemo={setDemo} onError={setError} />;

  const teamA = demo.match.score.A;
  const teamB = demo.match.score.B;

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      {/* header */}
      <header className="flex items-center justify-between border-b border-grid px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="display text-lg font-semibold">{demo.match.map}</span>
          <span className="num text-sm text-muted">
            <span className="text-t">A {teamA}</span> — <span className="text-ct">{teamB} B</span>
          </span>
          <span className="text-xs text-muted">
            {demo.match.demo_type} · {demo.match.rounds_played} rounds
          </span>
        </div>
        <button
          onClick={() => setDebug((d) => !d)}
          className={`rounded px-3 py-1 text-xs ${debug ? "bg-live text-bg" : "bg-raised text-muted hover:text-ink"}`}
        >
          debug overlay
        </button>
      </header>

      {demo.warnings.length > 0 && (
        <div className="border-b border-grid bg-surface px-5 py-1.5 text-xs text-t">
          ⚠ {demo.warnings[0]}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left rail */}
        <aside className="w-44 shrink-0 border-r border-grid bg-surface">
          <RoundRail rounds={demo.rounds} selected={roundNo} onSelect={setRoundNo} />
        </aside>

        {/* center: viewer */}
        <main className="flex min-w-0 flex-1 flex-col items-center gap-4 overflow-auto p-6">
          {round && (
            <RoundHeader
              roundNo={roundNo}
              reason={round.end_reason}
              winner={round.winner_side}
              buy={round.buy}
            />
          )}
          <div style={{ width: CANVAS }} className="relative">
            <RadarCanvas
              cal={cal}
              radarImg={radarImg}
              size={CANVAS}
              slots={slots}
              labelBy={labelBy}
              frame={curFrame}
              kills={debug ? [] : kills}
              utility={debug ? [] : utility}
              bomb={debug ? null : bomb}
              refs={refs}
            />
            {debug && <DebugLegend />}
            {!radarImg && !debug && (
              <div className="num absolute bottom-2 right-2 rounded bg-surface/80 px-2 py-0.5 text-[10px] text-muted">
                no radar bitmap — calibrated grid
              </div>
            )}
          </div>
          {round && posRound && (
            <div style={{ width: CANVAS }}>
              <ScrubBar
                round={round}
                frameTicks={frameTicks}
                index={index}
                playing={playing}
                tickrate={demo.match.tickrate}
                onScrub={(i) => {
                  setIndex(i);
                  setPlaying(false);
                }}
                onTogglePlay={() => setPlaying((p) => !p)}
              />
            </div>
          )}
        </main>

        {/* right: stats */}
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-grid bg-surface p-4">
          <ScoreboardPanel demo={demo} />
        </aside>
      </div>
    </div>
  );
}

/** Official reference points (ink) + demo-derived points (ember). Overlap
 * proves the world->radar transform is calibrated for this map. */
function computeDebugRefs(cal: MapCalibration, demo: Demo): RefMark[] {
  const out: RefMark[] = [];
  const size = cal.radar_size;
  const rp = cal.reference_points;
  const ink = "#e6edf2";
  const ember = "#d8654a";

  // Official anchors from the overview file (fractions of radar size).
  for (const [key, val] of Object.entries(rp)) {
    if (!Array.isArray(val)) continue;
    const [fx, fy] = val as [number, number];
    out.push({ px: fx * size, py: fy * size, label: key, color: ink });
  }

  // Demo-derived: team spawns from round 1's first frame, and bomb plants.
  const r1 = demo.positions?.rounds.find((r) => r.round_number === 1);
  const slots = demo.positions?.player_slots ?? [];
  const label = labelBySteamId(demo);
  if (r1 && r1.frames.length) {
    const f0 = r1.frames[0][1];
    const acc: Record<"A" | "B", { x: number; y: number; n: number }> = {
      A: { x: 0, y: 0, n: 0 },
      B: { x: 0, y: 0, n: 0 },
    };
    for (let i = 0; i < slots.length; i++) {
      const sf = f0[i];
      const lab = label.get(slots[i]);
      if (!sf || !lab) continue;
      acc[lab].x += sf[0];
      acc[lab].y += sf[1];
      acc[lab].n++;
    }
    (["A", "B"] as const).forEach((lab) => {
      if (acc[lab].n === 0) return;
      const wx = acc[lab].x / acc[lab].n;
      const wy = acc[lab].y / acc[lab].n;
      const { px, py } = worldToRadar(cal, wx, wy);
      out.push({ px, py, label: `${lab} spawn`, color: ember });
    });
  }
  // Bomb plants across all rounds (transformed).
  for (const r of demo.rounds) {
    for (const b of r.bomb_events) {
      if (b.kind !== "planted" || !b.player) continue;
      const pr = demo.positions?.rounds.find((p) => p.round_number === r.number);
      if (!pr) continue;
      const slot = slots.indexOf(b.player);
      if (slot < 0) continue;
      const fi = frameIndexForTick(pr, b.tick);
      const sf = pr.frames[fi]?.[1]?.[slot];
      if (!sf) continue;
      const { px, py } = worldToRadar(cal, sf[0], sf[1]);
      out.push({ px, py, label: "", color: ember });
    }
  }
  return out;
}

function RoundHeader({
  roundNo,
  reason,
  winner,
  buy,
}: {
  roundNo: number;
  reason: string;
  winner: string;
  buy: { T: string; CT: string };
}) {
  return (
    <div className="flex w-full items-center justify-between" style={{ maxWidth: CANVAS }}>
      <span className="display text-sm">
        Round <span className="num">{roundNo}</span>
      </span>
      <span className="text-xs text-muted">
        won by <span className={winner === "CT" ? "text-ct" : "text-t"}>{winner}</span> · {reason}
      </span>
      <span className="num text-xs text-muted">
        T {buy.T} / CT {buy.CT}
      </span>
    </div>
  );
}

function ScoreboardPanel({ demo }: { demo: Demo }) {
  return (
    <div>
      <div className="display mb-2 text-xs uppercase tracking-wider text-muted">Scoreboard</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th className="text-left font-normal">player</th>
            <th className="num text-right font-normal">K</th>
            <th className="num text-right font-normal">D</th>
            <th className="num text-right font-normal">A</th>
            <th className="num text-right font-normal">ADR</th>
          </tr>
        </thead>
        <tbody>
          {demo.players.map((p) => (
            <tr key={p.steamid} className="border-t border-grid/50">
              <td className="truncate py-1">
                <span className={p.team_label === "A" ? "text-t" : "text-ct"}>●</span>{" "}
                <span className="text-ink">{p.name}</span>
              </td>
              <td className="num text-right">{p.kills}</td>
              <td className="num text-right text-muted">{p.deaths}</td>
              <td className="num text-right text-muted">{p.assists}</td>
              <td className="num text-right">{p.adr}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DebugLegend() {
  return (
    <div className="absolute left-2 top-2 rounded bg-surface/90 px-3 py-2 text-[11px] leading-relaxed">
      <div className="display mb-1 text-muted">alignment check</div>
      <div>
        <span style={{ color: "#e6edf2" }}>◯</span> official (overview file)
      </div>
      <div>
        <span style={{ color: "#d8654a" }}>✛</span> demo-derived (transform)
      </div>
      <div className="mt-1 text-muted">they should overlap</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-muted">{children}</div>
  );
}

function DropZone({
  onDemo,
  onError,
}: {
  onDemo: (d: Demo) => void;
  onError: (e: string) => void;
}) {
  const [drag, setDrag] = useState(false);
  const read = (file: File) => {
    file
      .text()
      .then((t) => JSON.parse(t) as Demo)
      .then((d) => {
        if (!d.ok) throw new Error("parse failed");
        onDemo(d);
      })
      .catch(() => onError("That file is not a valid out.json from parse_demo.py."));
  };
  return (
    <div className="flex h-full items-center justify-center bg-bg p-8">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) read(f);
        }}
        className={`flex w-full max-w-md cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-12 text-center ${
          drag ? "border-live bg-surface" : "border-grid"
        }`}
      >
        <span className="display text-lg">Load a demo</span>
        <span className="text-sm text-muted">
          Drop <span className="num">out.json</span> here, or click to choose. Generate it with{" "}
          <span className="num">python scripts/parse_demo.py your.dem &gt; out.json</span>
        </span>
        <input
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && read(e.target.files[0])}
        />
      </label>
    </div>
  );
}
