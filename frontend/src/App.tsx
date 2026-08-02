import { useEffect, useMemo, useState } from "react";
import type { MapCalibration } from "./lib/coords";
import { worldToRadar } from "./lib/coords";
import type { Demo, LogEntry, PositionRound, SlotFrame } from "./lib/demo";
import { buildEventLog, interpolateFrame, labelBySteamId } from "./lib/demo";
import { RadarCanvas, type KillMark, type RefMark, type UtilMark } from "./components/RadarCanvas";
import { LeftSidebar } from "./components/LeftSidebar";
import { EventLog } from "./components/EventLog";
import { Scoreboard } from "./components/Scoreboard";
import { ScrubBar } from "./components/ScrubBar";
import { AuthModal } from "./components/AuthModal";

const CANVAS_MAX = 720;
const asset = (p: string) => `${import.meta.env.BASE_URL}${p.replace(/^\//, "")}`;

// Fit the square viewer to the available height so the scrub controls stay on
// screen without scrolling. Clamped so it never gets tiny or oversized.
function fitCanvas() {
  if (typeof window === "undefined") return CANVAS_MAX;
  return Math.max(420, Math.min(CANVAS_MAX, window.innerHeight - 250));
}

export default function App() {
  const [cal, setCal] = useState<MapCalibration | null>(null);
  const [radarImg, setRadarImg] = useState<HTMLImageElement | null>(null);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [roundNo, setRoundNo] = useState(1);
  const [playhead, setPlayhead] = useState(0); // float tick
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const [debug, setDebug] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [auth, setAuth] = useState<null | "signin" | "register">(null);
  const [size, setSize] = useState(fitCanvas);

  useEffect(() => {
    const on = () => setSize(fitCanvas());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // calibration + optional radar bitmap
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

  // auto-load bundled sample
  useEffect(() => {
    fetch(asset("demo/sample.json"))
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
  const slots = demo?.positions?.player_slots ?? [];
  const labelBy = useMemo(() => (demo ? labelBySteamId(demo) : new Map()), [demo]);
  const rangeLo = round?.freeze_end_tick ?? 0;
  const rangeHi = round?.end_tick ?? 1;

  const log: LogEntry[] = useMemo(
    () => (round && demo ? buildEventLog(round, demo) : []),
    [round, demo],
  );

  // reset clock on round change
  useEffect(() => {
    setPlayhead(rangeLo);
    setPlaying(false);
  }, [roundNo, rangeLo]);

  // continuous playback clock — advances a float tick by real elapsed time.
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

  const kills: KillMark[] = useMemo(() => {
    if (!round || !posRound) return [];
    const out: KillMark[] = [];
    for (const k of round.kills) {
      if (k.tick > curTick || !k.victim) continue;
      const slot = slots.indexOf(k.victim);
      if (slot < 0) continue;
      const f = interpolateFrame(posRound, k.tick);
      const sf = f?.[slot];
      if (sf) out.push({ x: sf[0], y: sf[1], headshot: k.headshot });
    }
    return out;
  }, [round, posRound, slots, curTick]);

  const utility: UtilMark[] = useMemo(() => {
    if (!round || !demo) return [];
    const rate = demo.match.tickrate || 64;
    const out: UtilMark[] = [];
    for (const u of round.utility) {
      if (u.x == null || u.y == null) continue;
      const dt = (playhead - u.tick) / rate;
      if (dt < 0 || dt > 2) continue;
      out.push({ x: u.x, y: u.y, kind: u.kind, alpha: 1 - dt / 2 });
    }
    return out;
  }, [round, demo, playhead]);

  const bomb = useMemo(() => {
    if (!round || !posRound) return null;
    const plant = round.bomb_events.find((b) => b.kind === "planted" && b.tick <= curTick);
    if (!plant || !plant.player) return null;
    const slot = slots.indexOf(plant.player);
    if (slot < 0) return null;
    const f = interpolateFrame(posRound, plant.tick);
    const sf = f?.[slot];
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
    <div className="flex h-full bg-bg text-ink">
      <LeftSidebar rounds={demo.rounds} selected={roundNo} onSelect={setRoundNo} onAuth={setAuth} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="relative flex items-center gap-4 border-b border-grid px-5 py-3">
          <div className="flex items-baseline gap-3">
            <span className="display text-lg font-semibold capitalize">
              {demo.match.map.replace("de_", "")}
            </span>
            <ScorePill a={demo.match.score.A} b={demo.match.score.B} />
            <span className="text-xs text-muted">
              {demo.match.demo_type} · {demo.match.rounds_played} rounds
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setScoreOpen((s) => !s)}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                scoreOpen ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
              }`}
            >
              Scoreboard ▾
            </button>
            <button
              onClick={() => setDebug((d) => !d)}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                debug ? "bg-live text-bg" : "text-muted hover:bg-raised/60 hover:text-ink"
              }`}
            >
              Debug overlay
            </button>
          </div>

          {scoreOpen && (
            <div className="absolute right-4 top-full z-40 mt-1" onMouseLeave={() => setScoreOpen(false)}>
              <Scoreboard demo={demo} />
            </div>
          )}
        </header>

        {demo.warnings.length > 0 && (
          <div className="border-b border-grid bg-surface px-5 py-1.5 text-xs text-t">
            ⚠ {demo.warnings[0]}
          </div>
        )}

        {/* body: viewer + log */}
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col items-center gap-4 overflow-auto p-6">
            {round && <RoundHeader round={round} width={size} />}
            <div style={{ width: size }} className="relative">
              <div
                className="rounded-xl p-px"
                style={{ boxShadow: "0 0 0 1px var(--grid), 0 20px 60px -30px #000" }}
              >
                <RadarCanvas
                  cal={cal}
                  radarImg={radarImg}
                  size={size}
                  slots={slots}
                  labelBy={labelBy}
                  frame={curFrame}
                  kills={debug ? [] : kills}
                  utility={debug ? [] : utility}
                  bomb={debug ? null : bomb}
                  refs={refs}
                />
              </div>
              {debug && <DebugLegend />}
              {!radarImg && !debug && (
                <div className="num absolute bottom-2 right-2 rounded bg-surface/80 px-2 py-0.5 text-[10px] text-muted">
                  no radar bitmap — calibrated grid
                </div>
              )}
            </div>
            {round && posRound && (
              <div style={{ width: size }}>
                <ScrubBar
                  round={round}
                  rangeLo={rangeLo}
                  rangeHi={rangeHi}
                  playhead={playhead}
                  playing={playing}
                  speed={speed}
                  tickrate={demo.match.tickrate}
                  onSeek={(t) => {
                    setPlayhead(t);
                    setPlaying(false);
                  }}
                  onTogglePlay={() => setPlaying((p) => !p)}
                  onSpeed={setSpeed}
                />
              </div>
            )}
          </main>

          <aside className="w-72 shrink-0 border-l border-grid bg-surface">
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
        </div>
      </div>

      {auth && <AuthModal mode={auth} onClose={() => setAuth(null)} />}
    </div>
  );
}

function ScorePill({ a, b }: { a: number; b: number }) {
  return (
    <span className="num inline-flex items-center overflow-hidden rounded-md border border-grid text-sm">
      <span className="bg-t/15 px-2 py-0.5 font-medium text-t">{a}</span>
      <span className="px-1 text-muted">:</span>
      <span className="bg-ct/15 px-2 py-0.5 font-medium text-ct">{b}</span>
    </span>
  );
}

function RoundHeader({ round, width }: { round: import("./lib/demo").Round; width: number }) {
  return (
    <div className="flex w-full items-center justify-between" style={{ maxWidth: width }}>
      <span className="display text-sm">
        Round <span className="num">{round.number}</span>
      </span>
      <span className="text-xs text-muted">
        won by <span className={round.winner_side === "CT" ? "text-ct" : "text-t"}>{round.winner_side}</span>{" "}
        · {round.end_reason.replace(/_/g, " ")}
      </span>
      <span className="num text-xs text-muted">
        T {round.buy.T} / CT {round.buy.CT}
      </span>
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
      const f = interpolateFrame(pr, b.tick);
      const sf = f?.[slot];
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
      <div className="mt-1 text-muted">they should overlap</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center bg-bg text-muted">{children}</div>;
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
