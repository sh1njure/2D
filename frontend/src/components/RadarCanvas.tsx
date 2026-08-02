import { useEffect, useRef } from "react";
import type { MapCalibration } from "../lib/coords";
import { worldToCanvas, yawToCanvasAngle } from "../lib/coords";
import type { SlotFrame } from "../lib/demo";

// Colours pulled from the token layer so the canvas matches the CSS palette.
function tokens() {
  const s = getComputedStyle(document.documentElement);
  return {
    bg: s.getPropertyValue("--bg").trim() || "#0e1419",
    grid: s.getPropertyValue("--grid").trim() || "#2a343d",
    ink: s.getPropertyValue("--ink").trim() || "#e6edf2",
    muted: s.getPropertyValue("--muted").trim() || "#8a98a5",
    A: s.getPropertyValue("--t").trim() || "#c79a4f", // team A started T
    B: s.getPropertyValue("--ct").trim() || "#4fa3c7", // team B started CT
    live: s.getPropertyValue("--live").trim() || "#d8654a",
  };
}

export interface KillMark {
  x: number; // world
  y: number;
  headshot: boolean;
}
export interface UtilMark {
  x: number;
  y: number;
  kind: "flash" | "he" | "smoke";
  alpha: number; // 0..1 bloom strength (fades with time from detonation)
}
export interface RefMark {
  px: number; // radar-space pixels (0..radar_size)
  py: number;
  label: string;
  color?: string;
}

interface Props {
  cal: MapCalibration;
  radarImg: HTMLImageElement | null;
  size: number; // css pixels (square)
  slots: string[]; // steamid per column
  labelBy: Map<string, "A" | "B">;
  frame: SlotFrame[] | null; // current positions
  kills?: KillMark[];
  utility?: UtilMark[];
  bomb?: { x: number; y: number } | null;
  refs?: RefMark[]; // debug overlay reference crosses
  showViewCones?: boolean;
}

export function RadarCanvas({
  cal,
  radarImg,
  size,
  slots,
  labelBy,
  frame,
  kills = [],
  utility = [],
  bomb = null,
  refs = [],
  showViewCones = true,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

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

    // --- backdrop -----------------------------------------------------------
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, size, size);

    if (radarImg) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(radarImg, 0, 0, size, size);
      ctx.globalAlpha = 1;
    } else {
      // No radar bitmap present: draw a calibrated grid so positions are still
      // legible and the transform is verifiable. 256-unit-ish grid in radar px.
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      const step = size / 8;
      ctx.globalAlpha = 0.5;
      for (let i = 1; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step, size);
        ctx.moveTo(0, i * step);
        ctx.lineTo(size, i * step);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- utility blooms (under players) -------------------------------------
    for (const u of utility) {
      const { cx, cy } = worldToCanvas(cal, u.x, u.y, size);
      const color = u.kind === "flash" ? c.ink : u.kind === "he" ? c.live : c.muted;
      ctx.globalAlpha = u.alpha * (u.kind === "smoke" ? 0.5 : 0.35);
      ctx.beginPath();
      ctx.arc(cx, cy, u.kind === "smoke" ? 16 : 12, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // --- bomb plant ---------------------------------------------------------
    if (bomb) {
      const { cx, cy } = worldToCanvas(cal, bomb.x, bomb.y, size);
      ctx.fillStyle = c.live;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 10px 'Chakra Petch', sans-serif";
      ctx.fillStyle = c.live;
      ctx.fillText("C4", cx + 7, cy + 3);
    }

    // --- kill markers --------------------------------------------------------
    for (const k of kills) {
      const { cx, cy } = worldToCanvas(cal, k.x, k.y, size);
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      const r = 4;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
      if (k.headshot) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
        ctx.strokeStyle = c.ink;
        ctx.stroke();
      }
    }

    // --- players -------------------------------------------------------------
    if (frame) {
      for (let i = 0; i < slots.length; i++) {
        const sf = frame[i];
        if (!sf) continue;
        const [x, y, , yaw, hp, alive] = sf;
        const label = labelBy.get(slots[i]) ?? "A";
        const col = label === "A" ? c.A : c.B;
        const { cx, cy } = worldToCanvas(cal, x, y, size);

        if (!alive) {
          // dead: faint hollow marker
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          continue;
        }

        // view cone from yaw
        if (showViewCones) {
          const a = yawToCanvasAngle(yaw);
          const spread = 0.5;
          const len = 16;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, len, a - spread, a + spread);
          ctx.closePath();
          const grad = ctx.createRadialGradient(cx, cy, 3, cx, cy, len);
          grad.addColorStop(0, col + "cc");
          grad.addColorStop(1, col + "00");
          ctx.fillStyle = grad;
          ctx.fill();
        }

        // body dot
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = c.bg;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // health ring (thin arc, drains with hp)
        if (hp < 100) {
          ctx.beginPath();
          ctx.arc(cx, cy, 7.5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * hp) / 100);
          ctx.strokeStyle = c.ink;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // --- debug reference crosses (on top) -----------------------------------
    for (const rp of refs) {
      const k = size / cal.radar_size;
      const cx = rp.px * k;
      const cy = rp.py * k;
      ctx.strokeStyle = rp.color ?? c.live;
      ctx.lineWidth = 1.5;
      const r = 8;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = "500 10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = rp.color ?? c.live;
      ctx.fillText(rp.label, cx + r + 2, cy + 3);
    }
  }, [cal, radarImg, size, slots, labelBy, frame, kills, utility, bomb, refs, showViewCones]);

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size, borderRadius: 8, display: "block" }}
      aria-label="Radar replay"
    />
  );
}
