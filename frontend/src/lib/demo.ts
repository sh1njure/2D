// Types + helpers for the parsed demo (out.json from scripts/parse_demo.py).
// Kept in sync with that script's output; schema_version guards drift.

export interface DemoSource {
  parser: string;
  parser_version: string;
  original_filename: string;
  file_size_bytes: number;
  sha256: string;
}

export interface PlayerStat {
  steamid: string;
  name: string;
  team_label: "A" | "B";
  start_side: "T" | "CT";
  kills: number;
  deaths: number;
  assists: number;
  hs_kills: number;
  adr: number;
}

export interface Kill {
  tick: number;
  attacker: string | null;
  victim: string | null;
  assister: string | null;
  weapon: string | null;
  headshot: boolean;
  noscope: boolean;
  through_smoke: boolean;
  attacker_blind: boolean;
  is_opening_duel: boolean;
}

export interface BombEvent {
  kind: "planted" | "defused" | "exploded";
  tick: number;
  player: string | null;
  site_entity: number | null;
}

export interface UtilityEvent {
  kind: "flash" | "he" | "smoke";
  tick: number;
  player: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  enemies_flashed?: number;
  blind_duration_total?: number;
}

export interface Round {
  number: number;
  start_tick: number;
  freeze_end_tick: number;
  end_tick: number;
  winner_side: "T" | "CT" | "?";
  end_reason: string;
  score_after: { A: number; B: number };
  buy: { T: string; CT: string; T_value: number; CT_value: number };
  kills: Kill[];
  bomb_events: BombEvent[];
  utility: UtilityEvent[];
}

// One player's state in a frame: [x, y, z, yaw, health, alive(0/1)].
export type SlotFrame = [number, number, number, number, number, number];
// A frame: [tick, [SlotFrame per slot]].
export type Frame = [number, SlotFrame[]];

export interface PositionRound {
  round_number: number;
  frame_count: number;
  frames: Frame[];
}

export interface Positions {
  tps: number;
  player_slots: string[]; // steamid per column
  frame_layout: string[];
  rounds: PositionRound[];
}

export interface Demo {
  ok: boolean;
  schema_version: number;
  warnings: string[];
  source: DemoSource;
  match: {
    map: string;
    server_name: string | null;
    demo_type: string;
    tickrate: number;
    tickrate_assumed: boolean;
    rounds_played: number;
    score: { A: number; B: number };
    teams: {
      A: { start_side: string; players: string[] };
      B: { start_side: string; players: string[] };
    };
  };
  players: PlayerStat[];
  rounds: Round[];
  positions: Positions | null;
}

/** steamid -> "A" | "B" team label, for colouring dots by team. */
export function labelBySteamId(demo: Demo): Map<string, "A" | "B"> {
  const m = new Map<string, "A" | "B">();
  for (const p of demo.players) m.set(p.steamid, p.team_label);
  return m;
}

/** steamid -> display name. */
export function nameBySteamId(demo: Demo): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of demo.players) m.set(p.steamid, p.name);
  return m;
}

/** Find the frame index in a round whose tick is closest to `tick`. */
export function frameIndexForTick(round: PositionRound, tick: number): number {
  const frames = round.frames;
  if (frames.length === 0) return 0;
  // frames are tick-ascending; binary search for nearest.
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid][0] < tick) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1][0] - tick) <= Math.abs(frames[lo][0] - tick)) {
    return lo - 1;
  }
  return lo;
}

const SEC_PER_TICK_FALLBACK = 1 / 64;

/** Seconds since a round's freeze-end for a given absolute tick. */
export function roundClock(round: Round, tick: number, tickrate: number): number {
  const rate = tickrate > 0 ? tickrate : 1 / SEC_PER_TICK_FALLBACK;
  return Math.max(0, (tick - round.freeze_end_tick) / rate);
}

export function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
