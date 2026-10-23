import type { Look, Profile } from '../../core/types';
import { jsonCodec, type Codec } from '../../net/codec';
import {
  DEUCE_RULES, FORMATS, isBool, isInt, isKey, isNum, isRec, isStr, PACES, parseProfile, REJECT_REASONS, SURFACES, type Rec,
} from '../../net/fields';
import type { ArcadeConfig, ArcadeState, PlayerInfo, PlayerInput } from '../core/types';

/** Protocol version (online spec §4); bump on any change to these messages. */
export const PROTO = 1;

/** The build this page runs (VITE_BUILD_ID, the short git hash; 'dev' when unset, as in tests). */
export const BUILD: string = buildId(import.meta.env.VITE_BUILD_ID);

/**
 * Application id sent in `hello` and `reject`. It carries the build, so a guest on another build is
 * turned away as "Versions differ": rollback needs the same sim code on both sides (online spec §1.2).
 */
export const APP_ID = `bbtennis-arcade@${BUILD}`;

/** Prefix of an Arcade host's PeerJS id; the rest is the game code. Typing-game codes use `bbtennis-`. */
export const PEER_PREFIX = 'bbtennis-arcade-';

/** Most inputs one `in` message carries. */
export const MAX_INPUTS_PER_MSG = 64;

/** Largest packed input (packInput). */
const MAX_INPUT_CODE = 71;

/** Largest |adv| a peer may report (ticks); anything else is not a working peer. */
const MAX_ADV = 100_000;

/** Every message between two Arcade players (online spec §4). */
export type ArcadeMsg =
  | { type: 'hello'; proto: number; app: string; name: string; look: Look }
  | { type: 'welcome'; proto: number; hostProfile: Profile; config: ArcadeConfig }
  | { type: 'reject'; reason: 'version' | 'full' | 'in-match'; proto: number; app: string }
  | { type: 'lobby'; config: ArcadeConfig; ready: [boolean, boolean] }
  | { type: 'ready'; on: boolean }
  | { type: 'start'; m: number; config: ArcadeConfig; seed: number; players: [Profile, Profile] }
  | { type: 'in'; m: number; t: number; i: number[]; adv: number }
  | { type: 'sum'; m: number; t: number; h: number }
  | { type: 'state'; m: number; t: number; s: ArcadeState }
  | { type: 'ping'; id: number }
  | { type: 'pong'; id: number }
  | { type: 'rematch'; want: boolean }
  | { type: 'forfeit'; m: number; t: number; s: ArcadeState }
  | { type: 'leave' };

function buildId(v: unknown): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : 'dev';
}

/** One tick's input as an integer 0..71: (mx+1) + 3·(my+1) + 9·topspin + 18·slice + 36·lob (online spec §3.1). */
export function packInput(i: PlayerInput): number {
  return i.mx + 1 + 3 * (i.my + 1) + (i.topspin ? 9 : 0) + (i.slice ? 18 : 0) + (i.lob ? 36 : 0);
}

const AXIS = [-1, 0, 1] as const;

/** The input packed by packInput (`n` must be an integer 0..71). */
export function unpackInput(n: number): PlayerInput {
  return {
    mx: AXIS[n % 3]!,
    my: AXIS[Math.floor(n / 3) % 3]!,
    topspin: Math.floor(n / 9) % 2 === 1,
    slice: Math.floor(n / 18) % 2 === 1,
    lob: Math.floor(n / 36) === 1,
  };
}

const isCount = (v: unknown, min: number): v is number => isInt(v) && v >= min;
const isUint32 = (v: unknown): v is number => isInt(v) && v >= 0 && v <= 0xffffffff;

function parseConfig(v: unknown): ArcadeConfig | null {
  if (!isRec(v)) return null;
  const { format, deuceRule, surface, pace } = v;
  if (!isKey(FORMATS, format) || !isKey(DEUCE_RULES, deuceRule) || !isKey(SURFACES, surface) || !isKey(PACES, pace)) return null;
  return { format, deuceRule, surface, pace };
}

function parseReady(v: unknown): [boolean, boolean] | null {
  return Array.isArray(v) && v.length === 2 && isBool(v[0]) && isBool(v[1]) ? [v[0], v[1]] : null;
}

function parsePlayers(v: unknown): [Profile, Profile] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = parseProfile(v[0]);
  const b = parseProfile(v[1]);
  return a && b && [a, b];
}

function parseInputs(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_INPUTS_PER_MSG) return null;
  return v.every((n) => isInt(n) && n >= 0 && n <= MAX_INPUT_CODE) ? (v as number[]) : null;
}

const PHASES = { intro: true, setup: true, toss: true, rally: true, dead: true, over: true } as const;
const SHOT_KEYS = { topspin: true, slice: true, lob: true } as const;
const SHOT_TYPES = { topspin: true, slice: true, lob: true, smash: true, serveFlat: true, serveSlice: true, serveKick: true } as const;
const GRADES = { perfect: true, clean: true, rushed: true } as const;
const STROKES = { forehand: true, backhand: true, smash: true, serve: true } as const;
const CALLS = { fault: true, out: true, net: true, ace: true, winner: true, doubleFault: true, timeViolation: true, ballDropped: true } as const;
const KINDS = { human: true, cpu: true, remote: true } as const;
/** Most segments and bounces a flight has (the sim makes at most a handful). */
const MAX_FLIGHT_PARTS = 16;
/** Most sets a score lists (best of 3 sets; Full is one set). */
const MAX_SETS = 5;

type Check = (v: unknown) => boolean;

const isPlayerId = (v: unknown): boolean => v === 0 || v === 1;
const isVec2: Check = (v) => isRec(v) && isNum(v.x) && isNum(v.y);
const isVec3: Check = (v) => isRec(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);
const isPair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && isCount(v[0], 0) && isCount(v[1], 0);
const nullOr = (check: Check): Check => (v) => v === null || check(v);
const listOf = (check: Check, max: number): Check => (v) => Array.isArray(v) && v.length <= max && v.every(check);
const isRngState: Check = (v) => isRec(v) && isUint32(v.a) && isUint32(v.b) && isUint32(v.c) && isUint32(v.d);

/** A player of a state: a profile (sanitized and clamped) with its kind and CPU level; null when malformed. */
function parsePlayer(v: unknown): PlayerInfo | null {
  const profile = parseProfile(v);
  if (!profile || !isRec(v) || !isKey(KINDS, v.kind) || !(v.cpuLevel === null || isCount(v.cpuLevel, 0))) return null;
  return { ...profile, kind: v.kind, cpuLevel: v.cpuLevel };
}

const isPhase: Check = (v) => {
  if (!isRec(v) || !isKey(PHASES, v.kind)) return false;
  switch (v.kind) {
    case 'intro':
      return isCount(v.until, 0);
    case 'setup':
    case 'over':
      return isCount(v.since, 0);
    case 'toss':
      return isCount(v.at, 0);
    case 'dead':
      return isCount(v.until, 0) && (v.next === 'setup' || v.next === 'over');
    default:
      return true;
  }
};

const isScore: Check = (v) =>
  isRec(v) &&
  isKey(FORMATS, v.format) &&
  isKey(DEUCE_RULES, v.deuceRule) &&
  listOf(isPair, MAX_SETS)(v.setGames) &&
  listOf(nullOr(isPair), MAX_SETS)(v.setTiebreaks) &&
  isPair(v.games) &&
  isPair(v.points) &&
  isBool(v.inTiebreak) &&
  isPair(v.setsWon) &&
  isPlayerId(v.firstServerOfMatch) &&
  isPlayerId(v.gameServer) &&
  nullOr(isPlayerId)(v.winner);

const isPlayerState: Check = (v) =>
  isRec(v) &&
  isVec2(v.pos) &&
  isVec2(v.vel) &&
  nullOr((c) => isRec(c) && isKey(SHOT_KEYS, c.shot) && isCount(c.tick, 0) && nullOr(isVec2)(c.step))(v.commit) &&
  nullOr((k) => isKey(SHOT_KEYS, k))(v.pending) &&
  isRec(v.held) &&
  isBool(v.held.topspin) &&
  isBool(v.held.slice) &&
  isBool(v.held.lob) &&
  nullOr((w) => isRec(w) && isCount(w.tick, 0) && isKey(STROKES, w.stroke) && isBool(w.stretch))(v.lastSwing);

const isHit: Check = (v) =>
  isRec(v) &&
  isCount(v.tick, 0) &&
  isPlayerId(v.player) &&
  isKey(SHOT_TYPES, v.type) &&
  isKey(GRADES, v.grade) &&
  isBool(v.stretch) &&
  isBool(v.volley) &&
  isNum(v.power) &&
  isVec3(v.contact) &&
  isVec2(v.target) &&
  isNum(v.T);

const isFlight: Check = (v) =>
  isRec(v) &&
  isHit(v.hit) &&
  Array.isArray(v.segments) &&
  v.segments.length >= 1 &&
  listOf((g) => isRec(g) && isNum(g.t0) && isVec3(g.p0) && isVec3(g.v0) && isVec3(g.a), MAX_FLIGHT_PARTS)(v.segments) &&
  listOf((b) => isRec(b) && isNum(b.t) && isVec2(b.at), MAX_FLIGHT_PARTS)(v.bounces) &&
  nullOr(isNum)(v.netT) &&
  isBool(v.net) &&
  isNum(v.tEnd) &&
  isNum(v.tGone);

const isPoint: Check = (v) =>
  isRec(v) &&
  (v.serveNo === 1 || v.serveNo === 2) &&
  isCount(v.hits, 0) &&
  isBool(v.serveUnbounced) &&
  nullOr((c) => isRec(c) && isKey(CALLS, c.call) && isPlayerId(c.player) && isCount(c.tick, 0))(v.call);

const isStats: Check = (v) =>
  isRec(v) &&
  ['pointsWon', 'aces', 'doubleFaults', 'winners', 'errors', 'hits', 'perfectHits'].every((k) => isCount(v[k], 0)) &&
  isNum(v.fastestServeKmh);

/**
 * Check of a whole match state from the other player (the host's resync, online spec §3.4, or a
 * forfeit's final state, §3.6), field by field, so that no state it accepts can make the sim or the
 * renderer throw: every number finite, every index a player, every enum known, every list bounded.
 * Names are sanitized and looks clamped. Returns the state (players replaced by their clean copies),
 * or null.
 */
function parseState(v: unknown): ArcadeState | null {
  if (!isRec(v) || v.v !== 1 || !isCount(v.tick, 0) || !parseConfig(v.config)) return null;
  if (!Array.isArray(v.players) || v.players.length !== 2) return null;
  const p0 = parsePlayer(v.players[0]);
  const p1 = parsePlayer(v.players[1]);
  if (!p0 || !p1) return null;
  const ok =
    isPhase(v.phase) &&
    isScore(v.score) &&
    Array.isArray(v.p) &&
    v.p.length === 2 &&
    v.p.every(isPlayerState) &&
    nullOr(isFlight)(v.flight) &&
    nullOr((t) => isRec(t) && isCount(t.tick, 0) && isPlayerId(t.player))(v.toss) &&
    isPoint(v.point) &&
    nullOr((n) => isCount(n, 0))(v.serveClockFrom) &&
    Array.isArray(v.stats) &&
    v.stats.length === 2 &&
    v.stats.every(isStats) &&
    isCount(v.longestRally, 0) &&
    isCount(v.pointNo, 0) &&
    (v.status === 'playing' || v.status === 'over') &&
    nullOr(isPlayerId)(v.winner) &&
    isRec(v.rng) &&
    Array.isArray(v.rng.hits) &&
    v.rng.hits.length === 2 &&
    v.rng.hits.every(isRngState) &&
    isRngState(v.rng.match);
  return ok ? { ...(v as unknown as ArcadeState), players: [p0, p1] } : null;
}

function parseFields(m: Rec): ArcadeMsg | null {
  switch (m.type) {
    case 'hello': {
      const profile = parseProfile({ name: m.name, look: m.look });
      if (!isInt(m.proto) || !isStr(m.app) || !profile) return null;
      return { type: 'hello', proto: m.proto, app: m.app, name: profile.name, look: profile.look };
    }
    case 'welcome': {
      const hostProfile = parseProfile(m.hostProfile);
      const config = parseConfig(m.config);
      return isInt(m.proto) && hostProfile && config ? { type: 'welcome', proto: m.proto, hostProfile, config } : null;
    }
    case 'reject':
      if (!isKey(REJECT_REASONS, m.reason) || !isInt(m.proto) || !isStr(m.app)) return null;
      return { type: 'reject', reason: m.reason, proto: m.proto, app: m.app };
    case 'lobby': {
      const config = parseConfig(m.config);
      const ready = parseReady(m.ready);
      return config && ready && { type: 'lobby', config, ready };
    }
    case 'ready':
      return isBool(m.on) ? { type: 'ready', on: m.on } : null;
    case 'start': {
      const config = parseConfig(m.config);
      const players = parsePlayers(m.players);
      if (!isCount(m.m, 1) || !isInt(m.seed) || !config || !players) return null;
      return { type: 'start', m: m.m, config, seed: m.seed, players };
    }
    case 'in': {
      const i = parseInputs(m.i);
      if (!isCount(m.m, 1) || !isCount(m.t, 1) || !i || !isInt(m.adv) || Math.abs(m.adv) > MAX_ADV) return null;
      return { type: 'in', m: m.m, t: m.t, i, adv: m.adv };
    }
    case 'sum':
      return isCount(m.m, 1) && isCount(m.t, 0) && isUint32(m.h) ? { type: 'sum', m: m.m, t: m.t, h: m.h } : null;
    case 'state':
    case 'forfeit': {
      const s = parseState(m.s);
      return isCount(m.m, 1) && isCount(m.t, 0) && s !== null && s.tick === m.t ? { type: m.type, m: m.m, t: m.t, s } : null;
    }
    case 'ping':
    case 'pong':
      return isInt(m.id) ? { type: m.type, id: m.id } : null;
    case 'rematch':
      return isBool(m.want) ? { type: 'rematch', want: m.want } : null;
    case 'leave':
      return { type: 'leave' };
    default:
      return null;
  }
}

/**
 * Validates a received message (online spec §4): a clean copy (unknown fields dropped, names
 * sanitized, look indices clamped), or null for an unknown type or bad fields. Its size is the
 * codec's to check.
 */
export function parseArcadeMsg(raw: unknown): ArcadeMsg | null {
  return isRec(raw) ? parseFields(raw) : null;
}

/** The Arcade's wire codec: JSON strings of at most 32 000 bytes, checked by parseArcadeMsg. */
export const ARCADE_CODEC: Codec<ArcadeMsg> = jsonCodec(parseArcadeMsg);

/** The Arcade's PeerJS protocol: its codec and its own game-code namespace. */
export const ARCADE_RTC = { codec: ARCADE_CODEC, prefix: PEER_PREFIX } as const;
