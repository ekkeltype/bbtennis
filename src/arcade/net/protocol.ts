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
  | { type: 'forfeit' }
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

const isVec2 = (v: unknown): boolean => isRec(v) && isNum(v.x) && isNum(v.y);

/** A player of a state: a profile (sanitized and clamped) and its kind and CPU level as sent. */
function parsePlayer(v: unknown): PlayerInfo | null {
  const profile = parseProfile(v);
  return profile && isRec(v) ? ({ ...v, ...profile } as unknown as PlayerInfo) : null;
}

/**
 * Structural check of a match state (the host's, for a resync, online spec §3.4): its version, tick,
 * options, both players (names sanitized, looks clamped), phase, the two player states' positions,
 * the flight, score, stats and RNG streams by shape. The rest passes through: it comes from a host on
 * the same build, so a deeper check would only repeat the sim's own types.
 */
function parseState(v: unknown): ArcadeState | null {
  if (!isRec(v) || v.v !== 1 || !isCount(v.tick, 0) || !parseConfig(v.config)) return null;
  if (!Array.isArray(v.players) || v.players.length !== 2) return null;
  const p0 = parsePlayer(v.players[0]);
  const p1 = parsePlayer(v.players[1]);
  if (!p0 || !p1) return null;
  if (!isRec(v.phase) || !isKey(PHASES, v.phase.kind) || !isRec(v.score) || !isRec(v.point)) return null;
  if (!Array.isArray(v.p) || v.p.length !== 2 || !v.p.every((p) => isRec(p) && isVec2(p.pos) && isVec2(p.vel) && isRec(p.held))) return null;
  if (v.flight !== null && !(isRec(v.flight) && isRec(v.flight.hit) && Array.isArray(v.flight.segments) && Array.isArray(v.flight.bounces))) return null;
  if (!Array.isArray(v.stats) || v.stats.length !== 2 || !v.stats.every(isRec)) return null;
  if (!isRec(v.rng) || !Array.isArray(v.rng.hits) || v.rng.hits.length !== 2 || !isRec(v.rng.match)) return null;
  if (v.status !== 'playing' && v.status !== 'over') return null;
  return { ...(v as unknown as ArcadeState), players: [p0, p1] };
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
    case 'state': {
      const s = parseState(m.s);
      return isCount(m.m, 1) && isCount(m.t, 0) && s ? { type: 'state', m: m.m, t: m.t, s } : null;
    }
    case 'ping':
    case 'pong':
      return isInt(m.id) ? { type: m.type, id: m.id } : null;
    case 'rematch':
      return isBool(m.want) ? { type: 'rematch', want: m.want } : null;
    case 'forfeit':
    case 'leave':
      return { type: m.type };
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
