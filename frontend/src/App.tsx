import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MapCalibration } from "./lib/coords";
import { worldToRadar } from "./lib/coords";
import type { Demo, LogEntry, PositionRound, SlotFrame } from "./lib/demo";
import {
  buildEventLog,
  fmtClock,
  interpolateFrame,
  labelBySteamId,
  liveStats,
  nameBySteamId,
  roundClock,
} from "./lib/demo";
import { MapView, type KillMark, type RefMark, type UtilShape } from "./components/MapView";
import { EventLog } from "./components/EventLog";
import { Timeline } from "./components/Timeline";
import { RoundStrip } from "./components/RoundStrip";
import { Scoreboard } from "./components/Scoreboard";
import { AuthModal } from "./components/AuthModal";

const asset = (p: string) => `${import.meta.env.BASE_URL}${p.replace(/^\//, "")}`;

// Utility lifetimes (seconds) — how long each effect stays drawn.
const UTIL_LIFE: Record<string, number> = {
  smoke: 15,
  molotov: 7,
  flash: 0.5,
  he: 0.4,
  decoy: 15,
};

export default function App() {
  const [cal, setCal] = useState<MapCalibration | null>(null);
  const [radarImg, setRadarImg] = useState<HTMLImageElement | null>(null);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [roundNo, setRoundNo] = useState(1);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [debug, setDebug] = useState(false);
  const [authMode, setAuthMode] = useState<null | "signin" | "register">(null);

  // measure the left zone so the map fills it as a square
  const leftRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState(560);
  useLayoutEffect(() => {
    const el = leftRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth - 32;
      const h = el.clientHeight - 84; // leave room for the timeline
      setMapSize(Math.max(360, Math.min(1024, Math.min(w, h))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [demo]);

  useEffect(() => {
    const map = demo?.match.map ?? "de_inferno";
    fetch(asset(`maps/${map}.json`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`no calibration for ${map}`))))
      .then(setCal)
      .catch(() => setError(`Missing map calibration for ${map}.`));
    const img = new Image();
    img.onload = () => setRadarImg(img);
    img.onerror = () => setRadarImg(null);
    img.src = asset(`maps/${map}.png`);
  }, [demo?.match.map]);

  useEffect(() => {
    fetch(asset("demo/sample.json"))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Demo) => setDemo(d))
      .catch(() => {});
  }, []);

  const round = useMemo(() => demo?.rounds.find((r) => r.number === roundNo) ?? null, [demo, roundNo]);
  const posRound: PositionRound | null = useMemo(
    () => demo?.positions?.rounds.find((r) => r.round_number === roundNo) ?? null,
    [demo, roundNo],
  );
  const slots = demo?.positions?.player_slots ?? [];
  const labelBy = useMemo(() => (demo ? labelBySteamId(demo) : new Map()), [demo]);
  const nameBy = useMemo(() => (demo ? nameBySteamId(demo) : new Map()), [demo]);
  const rangeLo = round?.freeze_end_tick ?? 0;
  const rangeHi = round?.end_tick ?? 1;
  const log: LogEntry[] = useMemo(() => (round && demo ? buildEventLog(round, demo) : []), [round, demo]);

  useEffect(() => {
    setPlayhead(rangeLo);
    setPlaying(false);
  }, [roundNo, rangeLo]);

  useEffect(() => {
    if (!playing) return;
    const rate = demo?.match.tickrate || 64;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((p) => {
        const next = p + dt * rate * speed;
        if (next >= rangeHi) {
          setPlaying(false);
          return rangeHi;
        }
        return next;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, demo, rangeHi]);

  const curTick = Math.floor(playhead);
  const curFrame: SlotFrame[] | null = useMemo(
    () => (posRound ? interpolateFrame(posRound, playhead) : null),
    [posRound, playhead],
  );
  const live = useMemo(() => (demo ? liveStats(demo, curTick) : new Map()), [demo, curTick]);

  const kills: KillMark[] = useMemo(() => {
    if (!round || !posRound) return [];
    const out: KillMark[] = [];
    for (const k of round.kills) {
      if (k.tick > curTick || !k.victim) continue;
      const slot = slots.indexOf(k.victim);
      if (slot < 0) continue;
      const sf = interpolateFrame(posRound, k.tick)?.[slot];
      if (sf) out.push({ x: sf[0], y: sf[1], headshot: k.headshot });
    }
    return out;
  }, [round, posRound, slots, curTick]);

  const utils: UtilShape[] = useMemo(() => {
    if (!round || !demo) return [];
    const rate = demo.match.tickrate || 64;
    const out: UtilShape[] = [];
    for (const u of round.utility) {
      if (u.x == null || u.y == null) continue;
      const life = UTIL_LIFE[u.kind] ?? 1;
      const age = (playhead - u.tick) / rate;
      if (age < 0 || age > life) continue;
      out.push({ kind: u.kind as UtilShape["kind"], x: u.x, y: u.y, age, life });
    }
    return out;
  }, [round, demo, playhead]);

  const bomb = useMemo(() => {
    if (!round || !posRound) return null;
    const plant = round.bomb_events.find((b) => b.kind === "planted" && b.tick <= curTick);
    if (!plant || !plant.player) return null;
    const slot = slots.indexOf(plant.player);
    if (slot < 0) return null;
    const sf = interpolateFrame(posRound, plant.tick)?.[slot];
    return sf ? { x: sf[0], y: sf[1] } : null;
  }, [round, posRound, slots, curTick]);

  const refs: RefMark[] = useMemo(
    () => (debug && cal && demo ? computeDebugRefs(cal, demo) : []),
    [debug, cal, demo],
  );

  if (error) return <Centered>{error}</Centered>;
  if (!cal) return <Centered>Loading map calibration…</Centered>;
  if (!demo) return <DropZone onDemo={setDemo} onError={setError} />;

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      {/* thin top bar */}
      <header className="flex items-center gap-3 border-b border-grid px-4 py-2">
        <span className="display grid h-6 w-6 place-items-center rounded bg-live text-[11px] font-bold text-bg">
          2D
        </span>
        <span className="display text-sm font-semibold">CS2 Review</span>
        <span className="text-xs capitalize text-muted">
          {demo.match.map.replace("de_", "")} · {demo.match.demo_type}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setDebug((d) => !d)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              debug ? "bg-live text-bg" : "text-muted hover:bg-raised hover:text-ink"
            }`}
          >
            Debug
          </button>
          <button
            onClick={() => setAuthMode("signin")}
            className="rounded-md border border-grid px-2.5 py-1 text-xs hover:bg-raised"
          >
            Sign in
          </button>
          <button
            onClick={() => setAuthMode("register")}
            className="rounded-md bg-live px-2.5 py-1 text-xs font-medium text-bg hover:brightness-110"
          >
            Register
          </button>
        </div>
      </header>

      {demo.warnings.length > 0 && (
        <div className="border-b border-grid bg-surface px-4 py-1 text-xs text-t">⚠ {demo.warnings[0]}</div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* FAR LEFT: round log */}
        <aside className="hidden w-80 shrink-0 border-r border-grid bg-surface lg:block">
          {round && (
            <EventLog
              entries={log}
              round={round}
              tickrate={demo.match.tickrate}
              curTick={curTick}
              onSeek={(t) => {
                setPlayhead(t);
                setPlaying(false);
              }}
            />
          )}
        </aside>

        {/* CENTER: map hero + timeline */}
        <div ref={leftRef} className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-4">
          <div className="relative" style={{ width: mapSize }}>
            <div style={{ boxShadow: "0 0 0 1px var(--grid), 0 24px 70px -35px #000", borderRadius: 12 }}>
              <MapView
                cal={cal}
                radarImg={radarImg}
                size={mapSize}
                slots={slots}
                labelBy={labelBy}
                nameBy={nameBy}
                frame={curFrame}
                utils={debug ? [] : utils}
                kills={debug ? [] : kills}
                bomb={debug ? null : bomb}
                refs={refs}
              />
            </div>
            {debug && <DebugLegend />}
            <div className="num absolute bottom-2 left-2 rounded bg-surface/70 px-2 py-0.5 text-[10px] text-muted">
              scroll = zoom · drag = pan · dbl-click = reset
            </div>
          </div>
          {round && (
            <div style={{ width: mapSize }}>
              <Timeline
                round={round}
                rangeLo={rangeLo}
                rangeHi={rangeHi}
                playhead={playhead}
                playing={playing}
                speed={speed}
                tickrate={demo.match.tickrate}
                markers={log}
                onSeek={(t) => {
                  setPlayhead(t);
                  setPlaying(false);
                }}
                onTogglePlay={() => setPlaying((p) => !p)}
                onSpeed={setSpeed}
              />
            </div>
          )}
        </div>

        {/* RIGHT: vertical flow */}
        <aside className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-l border-grid bg-surface">
          {round && (
            <section className="border-b border-grid p-4">
              <div className="flex items-baseline justify-between">
                <span className="display text-base font-semibold">
                  Round <span className="num">{round.number}</span>
                </span>
                <span className="num text-lg tabular-nums text-ink">
                  {fmtClock(roundClock(round, playhead, demo.match.tickrate))}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-muted">
                <span>
                  T <span className="text-t">{round.buy.T}</span> · CT{" "}
                  <span className="text-ct">{round.buy.CT}</span>
                </span>
                <span>{round.end_reason.replace(/_/g, " ")}</span>
              </div>
            </section>
          )}

          <section className="border-b border-grid p-4">
            <div className="display mb-2 text-[10px] uppercase tracking-wider text-muted">Rounds</div>
            <RoundStrip rounds={demo.rounds} selected={roundNo} onSelect={setRoundNo} />
          </section>

          <section className="border-b border-grid px-4 py-3">
            <div className="flex items-center justify-around">
              <TeamScore label="Team A" side="T" score={demo.match.score.A} color="text-t" />
              <span className="num text-2xl text-muted">:</span>
              <TeamScore label="Team B" side="CT" score={demo.match.score.B} color="text-ct" />
            </div>
          </section>

          <section className="p-2">
            <Scoreboard demo={demo} frame={curFrame} slots={slots} live={live} />
          </section>
        </aside>
      </div>

      {authMode && <AuthModal mode={authMode} onClose={() => setAuthMode(null)} />}
    </div>
  );
}

function TeamScore({ label, side, score, color }: { label: string; side: string; score: number; color: string }) {
  return (
    <div className="text-center">
      <div className={`num text-3xl font-semibold tabular-nums ${color}`}>{score}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted">
        {label} · {side}
      </div>
    </div>
  );
}

function computeDebugRefs(cal: MapCalibration, demo: Demo): RefMark[] {
  const out: RefMark[] = [];
  const size = cal.radar_size;
  const ink = "#e6edf2";
  const ember = "#d8654a";
  for (const [key, val] of Object.entries(cal.reference_points)) {
    if (!Array.isArray(val)) continue;
    const [fx, fy] = val as [number, number];
    out.push({ px: fx * size, py: fy * size, label: key, color: ink });
  }
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
      const { px, py } = worldToRadar(cal, acc[lab].x / acc[lab].n, acc[lab].y / acc[lab].n);
      out.push({ px, py, label: `${lab} spawn`, color: ember });
    });
  }
  for (const r of demo.rounds) {
    for (const b of r.bomb_events) {
      if (b.kind !== "planted" || !b.player) continue;
      const pr = demo.positions?.rounds.find((p) => p.round_number === r.number);
      if (!pr) continue;
      const slot = slots.indexOf(b.player);
      if (slot < 0) continue;
      const sf = interpolateFrame(pr, b.tick)?.[slot];
      if (!sf) continue;
      const { px, py } = worldToRadar(cal, sf[0], sf[1]);
      out.push({ px, py, label: "", color: ember });
    }
  }
  return out;
}

function DebugLegend() {
  return (
    <div className="absolute left-2 top-2 rounded-lg bg-surface/90 px-3 py-2 text-[11px] leading-relaxed backdrop-blur">
      <div className="display mb-1 text-muted">alignment check</div>
      <div>
        <span style={{ color: "#e6edf2" }}>◯</span> official (overview file)
      </div>
      <div>
        <span style={{ color: "#d8654a" }}>✛</span> demo-derived (transform)
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center bg-bg text-muted">{children}</div>;
}

function DropZone({ onDemo, onError }: { onDemo: (d: Demo) => void; onError: (e: string) => void }) {
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
          Drop <span className="num">out.json</span> here, or click to choose.
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
