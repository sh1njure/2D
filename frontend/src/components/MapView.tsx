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
export interface Projectile {
  kind: "he" | "flash" | "smoke" | "molotov" | "decoy";
  x: number;
  y: number;
  trail: [number, number][]; // world coords travelled so far
}
export interface KillMark {
  x: number;
  y: number;
  headshot: boolean;
}
// A bullet tracer: shooter world position + aim yaw, fading with age.
export interface Tracer {
  x: number;
  y: number;
  yaw: number;
  age: number; // seconds since the shot
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
  projectiles?: Projectile[];
  tracers?: Tracer[];
  kills?: KillMark[];
  bomb?: { x: number; y: number } | null;
  refs?: RefMark[];
}

// grenade kind -> official icon filename (bundled in public/icons/weapons)
const NADE_ICON: Record<string, string> = {
  he: "hegrenade",
  flash: "flashbang",
  smoke: "smokegrenade",
  molotov: "molotov",
  decoy: "decoy",
};

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
  projectiles = [],
  tracers = [],
  kills = [],
  bomb = null,
  refs = [],
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // preload the grenade icons once so they can be drawn on the canvas.
  const icons = useRef<Record<string, HTMLImageElement>>({});
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    const files = Array.from(new Set(Object.values(NADE_ICON)));
    let n = 0;
    files.forEach((f) => {
      const img = new Image();
      img.onload = () => {
        n++;
        if (n === files.length) setIconsReady(true);
      };
      img.src = `${base}icons/weapons/${f}.svg`;
      icons.current[f] = img;
    });
  }, []);

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

    // Countdown badge for timed utility (smoke/molotov). This small chip is a
    // deliberate readability affordance for the number — not a decorative shadow.
    const drawTimer = (cx: number, cy: number, remaining: number, bg: string, fg: string) => {
      if (remaining <= 0.05) return;
      const label = Math.ceil(remaining).toString();
      ctx.font = "600 11px 'IBM Plex Mono', monospace";
      const w = ctx.measureText(label).width;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2 - 4, cy - 8, w + 8, 16, 4);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy + 0.5);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    };

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
        grad.addColorStop(0, `rgba(214,224,232,${0.55 * fade})`);
        grad.addColorStop(0.85, `rgba(214,224,232,${0.22 * fade})`);
        grad.addColorStop(1, "rgba(214,224,232,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        // zone ring so the smoke's covered area is unmistakable
        ctx.strokeStyle = `rgba(226,233,240,${0.4 * fade})`;
        ctx.lineWidth = 1.25;
        ctx.stroke();
        drawTimer(cx, cy, u.life - u.age, "rgba(20,26,32,0.9)", `rgba(226,233,240,${0.9 * fade})`);
      } else if (u.kind === "molotov") {
        // Burning area rendered as a cluster of flickering flame cells (reads as
        // fire, not a single ember blob). Each cell pulses on its own phase.
        const fade = u.age < 0.3 ? u.age / 0.3 : 1 - t * 0.5;
        const R = wlen(105);
        const cells = 7;
        for (let ci = 0; ci < cells; ci++) {
          const ang = (ci / cells) * Math.PI * 2 + u.age * 0.6;
          const dist = ci === 0 ? 0 : R * (0.35 + 0.4 * ((ci * 37) % 100) / 100);
          const fx = cx + Math.cos(ang) * dist;
          const fy = cy + Math.sin(ang) * dist;
          const flick = 0.6 + 0.4 * Math.sin(u.age * 16 + ci * 1.7);
          const cr = wlen(38) * (0.7 + 0.3 * flick);
          const g = ctx.createRadialGradient(fx, fy, 1, fx, fy, cr);
          g.addColorStop(0, `rgba(255,210,90,${0.7 * fade * flick})`);
          g.addColorStop(0.45, `rgba(230,110,45,${0.5 * fade})`);
          g.addColorStop(1, "rgba(150,35,25,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(fx, fy, cr, 0, Math.PI * 2);
          ctx.fill();
        }
        // faint ember boundary of the covered area
        ctx.strokeStyle = `rgba(235,120,55,${0.3 * fade})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();
        drawTimer(cx, cy, u.life - u.age, "rgba(30,12,6,0.9)", `rgba(255,205,120,${0.95 * fade})`);
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

    // --- grenades in flight (real icons + trail) ----------------------------
    const drawIcon = (file: string, cx: number, cy: number, h: number, chip = true) => {
      const img = icons.current[file];
      if (!img || !img.complete || !img.naturalWidth) return;
      const w = h * (img.naturalWidth / img.naturalHeight);
      if (chip) {
        ctx.fillStyle = "rgba(14,20,25,0.65)";
        ctx.beginPath();
        ctx.roundRect(cx - w / 2 - 2, cy - h / 2 - 2, w + 4, h + 4, 3);
        ctx.fill();
      }
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    };

    for (const pr of projectiles) {
      const file = NADE_ICON[pr.kind];
      // trail
      if (pr.trail.length > 1) {
        ctx.strokeStyle = pr.kind === "he" || pr.kind === "molotov" ? c.live : c.muted;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        pr.trail.forEach(([wx, wy], idx) => {
          const { cx, cy } = proj(wx, wy);
          if (idx === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      const { cx, cy } = proj(pr.x, pr.y);
      drawIcon(file, cx, cy, 15, false);
    }

    // --- bullet tracers (short line from shooter along aim, fading) ----------
    for (const tr of tracers) {
      const { cx, cy } = proj(tr.x, tr.y);
      const a = yawToCanvasAngle(tr.yaw);
      const len = wlen(1300);
      const alpha = Math.max(0, 1 - tr.age / 0.12);
      if (alpha <= 0) continue;
      const ex = cx + Math.cos(a) * len;
      const ey = cy + Math.sin(a) * len;
      const grad = ctx.createLinearGradient(cx, cy, ex, ey);
      grad.addColorStop(0, `rgba(255,238,170,${0.85 * alpha})`);
      grad.addColorStop(1, "rgba(255,238,170,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
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

    // labels: plain text, no backing plate/shadow, overlap allowed.
    ctx.font = "500 10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    for (const p of ps.filter((q) => q.alive)) {
      ctx.fillStyle = p.col;
      ctx.fillText(p.name, p.cx, p.cy - 9);
    }
    ctx.textAlign = "start";

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
  }, [cal, radarImg, size, slots, labelBy, nameBy, frame, utils, projectiles, tracers, kills, bomb, refs, zoom, pan, iconsReady]);

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
