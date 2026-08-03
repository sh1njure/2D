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
  kind: "flash" | "he" | "smoke" | "molotov" | "decoy";
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

// One player's state in a frame:
//   [x, y, z, yaw, health, alive(0/1), weaponIdx(-1|table), money].
export type SlotFrame = [number, number, number, number, number, number, number, number];
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
  weapon_table: string[]; // weaponIdx -> weapon name
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

// --- smooth playback ----------------------------------------------------------
// The blob is sampled at 8 tps; playing those frames raw looks robotic. We keep
// a continuous playhead (a float tick) and interpolate positions between the two
// frames bracketing it, so rendering can run at 60fps.

/** Shortest-path angular interpolation in degrees. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * f;
}

/** Interpolated per-slot state at a fractional tick. hp/alive come from the
 *  earlier frame so a player isn't lerped through their death. */
export function interpolateFrame(pr: PositionRound, tick: number): SlotFrame[] | null {
  const frames = pr.frames;
  if (frames.length === 0) return null;
  const iLo = frameIndexForTick(pr, tick);
  // frameIndexForTick returns nearest; make sure we bracket forward.
  let i = iLo;
  if (frames[i][0] > tick && i > 0) i -= 1;
  const j = Math.min(i + 1, frames.length - 1);
  const t0 = frames[i][0];
  const t1 = frames[j][0];
  const frac = t1 > t0 ? Math.min(1, Math.max(0, (tick - t0) / (t1 - t0))) : 0;
  const a = frames[i][1];
  const b = frames[j][1];
  return a.map((sa, s) => {
    const sb = b[s];
    if (!sa) return sb ?? [0, 0, 0, 0, 0, 0, -1, 0];
    if (!sb) return sa;
    const L = (u: number, v: number) => u + (v - u) * frac;
    // positions/yaw interpolate; hp/alive/weapon/money take the earlier frame.
    return [
      L(sa[0], sb[0]),
      L(sa[1], sb[1]),
      L(sa[2], sb[2]),
      lerpAngle(sa[3], sb[3], frac),
      sa[4],
      sa[5],
      sa[6],
      sa[7],
    ] as SlotFrame;
  });
}

/** Weapon name for a weapon index, or null. */
export function weaponName(demo: Demo, idx: number): string | null {
  if (idx < 0 || !demo.positions) return null;
  return demo.positions.weapon_table[idx] ?? null;
}

export interface LiveStat {
  kills: number;
  deaths: number;
  assists: number;
}

/** Cumulative K/D/A per steamid as of an absolute tick (scans all rounds'
 *  kills up to `absTick`), so the scoreboard reads live during playback. */
export function liveStats(demo: Demo, absTick: number): Map<string, LiveStat> {
  const m = new Map<string, LiveStat>();
  const get = (sid: string) => {
    let s = m.get(sid);
    if (!s) {
      s = { kills: 0, deaths: 0, assists: 0 };
      m.set(sid, s);
    }
    return s;
  };
  for (const p of demo.players) get(p.steamid);
  for (const r of demo.rounds) {
    for (const k of r.kills) {
      if (k.tick > absTick) continue;
      if (k.attacker) get(k.attacker).kills++;
      if (k.victim) get(k.victim).deaths++;
      if (k.assister) get(k.assister).assists++;
    }
  }
  return m;
}

// --- event log ----------------------------------------------------------------
export type LogKind =
  | "kill"
  | "flash"
  | "he"
  | "smoke"
  | "molotov"
  | "decoy"
  | "plant"
  | "defuse"
  | "explode";

export interface LogEntry {
  tick: number;
  kind: LogKind;
  actor: string; // display name or "?"
  target?: string;
  weapon?: string;
  headshot?: boolean;
  actorLabel?: "A" | "B";
}

const NADE_LABEL: Record<string, string> = {
  flash: "flash",
  he: "HE",
  smoke: "smoke",
  molotov: "molotov",
  decoy: "decoy",
};

/** Chronological feed of a round's events for the log panel. */
export function buildEventLog(round: Round, demo: Demo): LogEntry[] {
  const name = nameBySteamId(demo);
  const label = labelBySteamId(demo);
  const nm = (sid: string | null) => (sid ? (name.get(sid) ?? "?") : "?");
  const out: LogEntry[] = [];

  for (const k of round.kills) {
    out.push({
      tick: k.tick,
      kind: "kill",
      actor: nm(k.attacker),
      target: nm(k.victim),
      weapon: k.weapon ?? undefined,
      headshot: k.headshot,
      actorLabel: k.attacker ? label.get(k.attacker) : undefined,
    });
  }
  for (const u of round.utility) {
    out.push({
      tick: u.tick,
      kind: u.kind,
      actor: nm(u.player),
      weapon: NADE_LABEL[u.kind] ?? u.kind,
      actorLabel: u.player ? label.get(u.player) : undefined,
    });
  }
  for (const b of round.bomb_events) {
    const kind = b.kind === "planted" ? "plant" : b.kind === "defused" ? "defuse" : "explode";
    out.push({
      tick: b.tick,
      kind,
      actor: nm(b.player),
      actorLabel: b.player ? label.get(b.player) : undefined,
    });
  }
  return out.sort((a, b) => a.tick - b.tick);
}
