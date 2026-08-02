import { useEffect, useRef, useState } from "react";
import type { MapCalibration } from "../lib/coords";
import { worldToRadar, yawToCanvasAngle } from "../lib/coords";
import type { SlotFrame } from "../lib/demo";

// A utility effect to draw, already resolved to world coords + age.
export interface UtilShape {
  kind: "smoke" | "flash" | "he" | "molotov" | "decoy";
  x: number;
  y: number;
  age: number; // seconds since detonation
  life: number; // total lifetime seconds
}
export interface KillMark {
  x: number;
  y: number;
  headshot: boolean;
}
export interface RefMark {
  px: number;
  py: number;
  label: string;
  color?: string;
}

interface Props {
  cal: MapCalibration;
  radarImg: HTMLImageElement | null;
  size: number;
  slots: string[];
  labelBy: Map<string, "A" | "B">;
  nameBy: Map<string, string>;
  frame: SlotFrame[] | null;
  utils?: UtilShape[];
  kills?: KillMark[];
  bomb?: { x: number; y: number } | null;
  refs?: RefMark[];
}

function tokens() {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  return {
    bg: g("--bg", "#0e1419"),
    grid: g("--grid", "#2a343d"),
    ink: g("--ink", "#e6edf2"),
    muted: g("--muted", "#8a98a5"),
    A: g("--t", "#c79a4f"),
    B: g("--ct", "#4fa3c7"),
    live: g("--live", "#d8654a"),
  };
}

export function MapView({
  cal,
  radarImg,
  size,
  slots,
  labelBy,
  nameBy,
  frame,
  utils = [],
  kills = [],
  bomb = null,
  refs = [],
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // reset view when the map/size changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [size, cal.map]);

  // Wheel zoom via a non-passive native listener so preventDefault works (React's
  // synthetic wheel handler is passive and can't stop the page from scrolling).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setZoom((z) => {
        const nz = Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        setPan((p) => ({ x: mx - ((mx - p.x) * nz) / z, y: my - ((my - p.y) * nz) / z }));
        return nz;
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = tokens();

    const k = (size / cal.radar_size) * zoom; // world-radar px -> canvas px
    const proj = (wx: number, wy: number) => {
      const { px, py } = worldToRadar(cal, wx, wy);
      return { cx: px * k + pan.x, cy: py * k + pan.y };
    };
    const wlen = (units: number) => (units / cal.scale) * k; // world length -> canvas px

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, size, size);

    // clip to the square so panned content doesn't bleed over the frame
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.clip();

    // --- map backdrop -------------------------------------------------------
    const span = cal.radar_size * k;
    if (radarImg) {
      ctx.drawImage(radarImg, pan.x, pan.y, span, span);
    } else {
      ctx.strokeStyle = c.grid;
      ctx.globalAlpha = 0.5;
      const step = span / 8;
      for (let i = 0; i <= 8; i++) {
        ctx.beginPath();
        ctx.moveTo(pan.x + i * step, pan.y);
        ctx.lineTo(pan.x + i * step, pan.y + span);
        ctx.moveTo(pan.x, pan.y + i * step);
        ctx.lineTo(pan.x + span, pan.y + i * step);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- utility (shape per type) -------------------------------------------
    for (const u of utils) {
      const { cx, cy } = proj(u.x, u.y);
      const t = Math.min(1, u.age / u.life);
      if (u.kind === "smoke") {
        // expanding then steady cloud; soft edge.
        const grow = Math.min(1, u.age / 0.6);
        const r = wlen(150) * grow;
        const fade = u.age > u.life - 1.5 ? Math.max(0, (u.life - u.age) / 1.5) : 1;
        const grad = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
        grad.addColorStop(0, `rgba(210,220,228,${0.5 * fade})`);
        grad.addColorStop(1, "rgba(210,220,228,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (u.kind === "molotov") {
        // burning area: flickering ember fill.
        const r = wlen(115);
        const fade = 1 - t;
        const flick = 0.75 + 0.25 * Math.sin(u.age * 22);
        const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
        grad.addColorStop(0, `rgba(224,110,60,${0.55 * fade * flick})`);
        grad.addColorStop(0.7, `rgba(200,70,40,${0.35 * fade})`);
        grad.addColorStop(1, "rgba(160,40,30,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (u.kind === "flash") {
        // bright short impulse.
        const a = Math.max(0, 1 - u.age / u.life);
        const r = wlen(90) * (0.6 + 0.4 * a);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `rgba(255,255,255,${0.85 * a})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (u.kind === "he") {
        const a = Math.max(0, 1 - u.age / u.life);
        const r = wlen(70) * (1 - a * 0.4);
        ctx.strokeStyle = `rgba(224,110,60,${a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // decoy: small dashed ring
        ctx.strokeStyle = c.muted;
        ctx.globalAlpha = 1 - t;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, wlen(30), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // --- bomb ---------------------------------------------------------------
    if (bomb) {
      const { cx, cy } = proj(bomb.x, bomb.y);
      ctx.fillStyle = c.live;
      ctx.beginPath();
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 10px 'Chakra Petch', sans-serif";
      ctx.fillText("C4", cx + 6, cy + 3);
    }

    // --- kills --------------------------------------------------------------
    for (const km of kills) {
      const { cx, cy } = proj(km.x, km.y);
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      const r = 4;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
      if (km.headshot) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
        ctx.strokeStyle = c.ink;
        ctx.stroke();
      }
    }

    // --- players + labels ---------------------------------------------------
    type P = { cx: number; cy: number; col: string; name: string; alive: boolean; hp: number; yaw: number };
    const ps: P[] = [];
    if (frame) {
      for (let i = 0; i < slots.length; i++) {
        const sf = frame[i];
        if (!sf) continue;
        const [x, y, , yaw, hp, alive] = sf;
        const { cx, cy } = proj(x, y);
        ps.push({
          cx,
          cy,
          col: (labelBy.get(slots[i]) ?? "A") === "A" ? c.A : c.B,
          name: nameBy.get(slots[i]) ?? "",
          alive: !!alive,
          hp,
          yaw,
        });
      }
    }

    for (const p of ps) {
      if (!p.alive) {
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      // view cone
      const a = yawToCanvasAngle(p.yaw);
      const len = 18;
      ctx.beginPath();
      ctx.moveTo(p.cx, p.cy);
      ctx.arc(p.cx, p.cy, len, a - 0.5, a + 0.5);
      ctx.closePath();
      const grad = ctx.createRadialGradient(p.cx, p.cy, 3, p.cx, p.cy, len);
      grad.addColorStop(0, p.col + "cc");
      grad.addColorStop(1, p.col + "00");
      ctx.fillStyle = grad;
      ctx.fill();
      // body
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = p.col;
      ctx.fill();
      ctx.strokeStyle = c.bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (p.hp < 100) {
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 7.5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * p.hp) / 100);
        ctx.strokeStyle = c.ink;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // labels with de-overlap: draw for living players, nudge collisions down.
    ctx.font = "500 10px 'Inter', sans-serif";
    const placed: { x: number; y: number }[] = [];
    for (const p of ps.filter((q) => q.alive).sort((u, v) => u.cy - v.cy)) {
      let ly = p.cy - 9;
      for (const q of placed) {
        if (Math.abs(q.x - p.cx) < 44 && Math.abs(q.y - ly) < 11) ly = q.y + 11;
      }
      placed.push({ x: p.cx, y: ly });
      const w = ctx.measureText(p.name).width;
      const lx = p.cx - w / 2;
      ctx.fillStyle = "rgba(14,20,25,0.72)";
      ctx.fillRect(lx - 3, ly - 9, w + 6, 12);
      ctx.fillStyle = c.ink;
      ctx.fillText(p.name, lx, ly);
    }

    // --- debug refs ---------------------------------------------------------
    for (const rp of refs) {
      const cx = rp.px * k + pan.x;
      const cy = rp.py * k + pan.y;
      ctx.strokeStyle = rp.color ?? c.live;
      ctx.lineWidth = 1.5;
      const r = 8;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (rp.label) {
        ctx.font = "500 10px 'IBM Plex Mono', monospace";
        ctx.fillStyle = rp.color ?? c.live;
        ctx.fillText(rp.label, cx + r + 2, cy + 3);
      }
    }

    ctx.restore();
  }, [cal, radarImg, size, slots, labelBy, nameBy, frame, utils, kills, bomb, refs, zoom, pan]);

  return (
    <canvas
      ref={ref}
      onDoubleClick={() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setPan({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
      }}
      onPointerUp={() => (drag.current = null)}
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        display: "block",
        cursor: drag.current ? "grabbing" : "grab",
        touchAction: "none",
      }}
      aria-label="Map replay — scroll to zoom, drag to pan, double-click to reset"
    />
  );
}
