// Coordinate transform — the heart of Phase 2.
//
// Ported verbatim from the INSTALLED awpy 2.0.2 (awpy.plot.utils.game_to_pixel_axis),
// not from memory:
//     px = (world_x - pos_x) / scale
//     py = (pos_y - world_y) / scale
// on a `radar_size` (1024) square image. pos_x is the world coord of the radar's
// upper-left; pos_y is the world coord of its TOP edge, hence the flip on Y.
//
// The constants come from the CS2 de_inferno overview file, not remembered
// numbers. The /debug overlay exists to prove this transform lands real
// reference points where they belong before we trust it.

export interface MapCalibration {
  map: string;
  radar_size: number;
  pos_x: number;
  pos_y: number;
  scale: number;
  lower_level_max_units: number | null;
  reference_points: Record<string, [number, number] | string>;
}

/** World (game) coords -> radar pixel coords, in [0, radar_size]. */
export function worldToRadar(
  cal: MapCalibration,
  x: number,
  y: number,
): { px: number; py: number } {
  return {
    px: (x - cal.pos_x) / cal.scale,
    py: (cal.pos_y - y) / cal.scale,
  };
}

/** Radar pixel -> canvas pixel, honouring the rendered canvas size. */
export function radarToCanvas(
  cal: MapCalibration,
  px: number,
  py: number,
  canvasSize: number,
): { cx: number; cy: number } {
  const k = canvasSize / cal.radar_size;
  return { cx: px * k, cy: py * k };
}

/** Convenience: world straight to canvas. */
export function worldToCanvas(
  cal: MapCalibration,
  x: number,
  y: number,
  canvasSize: number,
): { cx: number; cy: number } {
  const { px, py } = worldToRadar(cal, x, y);
  return radarToCanvas(cal, px, py, canvasSize);
}

/**
 * CS2 yaw is degrees CCW from the +X (east) axis. On the radar, +world-Y is up
 * but canvas +Y is down, so a yaw of 0 (east) points right, and increasing yaw
 * rotates counter-clockwise in world = clockwise-negated on canvas. Return the
 * canvas-space angle (radians) a view-cone should point.
 */
export function yawToCanvasAngle(yawDeg: number): number {
  return (-yawDeg * Math.PI) / 180;
}
