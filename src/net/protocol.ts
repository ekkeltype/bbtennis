import { POWER_MAX } from '../core/power';
import { sanitizeName } from '../core/text';
import type { GameEvent, Look, MatchConfig, PlayerInfo, Profile, PublicState, TrainingFlags, WordPackId } from '../core/types';
import { jsonCodec, type Codec, type EncodedMsg } from './codec';
import {
  DEUCE_RULES, FORMATS, isBool, isInt, isKey, isNum, isRec, isStr, PACES, parseLook, parseProfile, REJECT_REASONS, SURFACES, type Rec,
} from './fields';

/** Protocol version; bump on any change to the protocol, PublicState, TurnRunner or key classification (spec §5.3). */
export const PROTO = 2;

export { MAX_SEND_BYTES, type EncodedMsg } from './codec';

/** Application id sent in `hello` and `reject`. */
export const APP_ID = 'bbtennis';

/** parseMsg drops a value whose JSON is longer than this many characters (spec §5.3). */
export const MAX_MSG_CHARS = 32 * 1024;

/** Size of `msg` on the wire: the UTF-8 byte length of its JSON. */
export function msgBytes(msg: NetMsg): number {
  return NET_CODEC.bytes(msg);
}

/** Every message exchanged between host and guest (spec §5.3). `τ` is a turn-clock time in ms. */
export type NetMsg =
  | { type: 'hello'; proto: number; app: string; name: string; look: Look }
  | { type: 'welcome'; proto: number; hostProfile: Profile; config: MatchConfig }
  | { type: 'reject'; reason: 'version' | 'full' | 'in-match'; proto: number; app: string }
  | { type: 'lobby'; config: MatchConfig; ready: [boolean, boolean] }
  | { type: 'ready'; on: boolean }
  | { type: 'start'; config: MatchConfig; hostProfile: Profile; guestProfile: Profile }
  | { type: 'input'; seq: number; turn: number; k: string; τ: number }
  | { type: 'clock'; turn: number; τ: number }
  | { type: 'frame'; turn: number; τ: number; ev?: GameEvent[]; s?: PublicState }
  | { type: 'ping'; id: number }
  | { type: 'pong'; id: number }
  | { type: 'rematch'; want: boolean }
  | { type: 'forfeit' }
  | { type: 'leave' };

const WORD_PACKS: Record<WordPackId, true> = { everyday: true, sports: true, dojo: true, mixed: true };

const isStrGrid = (v: unknown): v is string[][] => Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every(isStr));

/** A guest key: one lowercase letter or 'toss' (spec §4.5). */
const isKeyInput = (v: unknown): v is string => isStr(v) && (v === 'toss' || /^[a-z]$/.test(v));

/** null = no training (valid); undefined = invalid. */
function parseTraining(v: unknown): TrainingFlags | null | undefined {
  if (v === null) return null;
  if (!isRec(v) || !isBool(v.serveClock) || !isBool(v.freezeUntilFirstKey)) return undefined;
  const fw = v.fixedWords;
  if (fw === null) return { serveClock: v.serveClock, freezeUntilFirstKey: v.freezeUntilFirstKey, fixedWords: null };
  if (!isRec(fw) || !isStrGrid(fw.serve) || !isStrGrid(fw.choice)) return undefined;
  return { serveClock: v.serveClock, freezeUntilFirstKey: v.freezeUntilFirstKey, fixedWords: { serve: fw.serve, choice: fw.choice } };
}

function parseConfig(v: unknown): MatchConfig | null {
  if (!isRec(v)) return null;
  const { format, pace, surface, wordPack, deuceRule } = v;
  if (!isKey(FORMATS, format) || !isKey(PACES, pace) || !isKey(SURFACES, surface)) return null;
  if (!isKey(WORD_PACKS, wordPack) || !isKey(DEUCE_RULES, deuceRule)) return null;
  const training = parseTraining(v.training);
  if (training === undefined) return null;
  return { format, pace, surface, wordPack, deuceRule, training };
}

/** Structural check of engine events: objects with a string `type` and numeric `turn` and `τ`. */
function parseEvents(v: unknown): GameEvent[] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every((e) => isRec(e) && isStr(e.type) && isNum(e.turn) && isNum(e.τ));
  return ok ? (v as GameEvent[]) : null;
}

function parsePlayer(v: unknown): PlayerInfo | null {
  if (!isRec(v)) return null;
  const profile = parseProfile(v);
  return profile && ({ ...v, ...profile } as unknown as PlayerInfo);
}

/** Top-level structural check of a PublicState; player names and looks are clamped, the rest passes through. */
function parseState(v: unknown): PublicState | null {
  if (!isRec(v) || v.v !== 2 || !isRec(v.score) || !isStr(v.status)) return null;
  if (v.turn !== null && !isRec(v.turn)) return null;
  if (!Array.isArray(v.players) || v.players.length !== 2) return null;
  const p0 = parsePlayer(v.players[0]);
  const p1 = parsePlayer(v.players[1]);
  if (!p0 || !p1) return null;
  const power = parsePower(v.power);
  if (power === null) return null;
  return { ...(v as unknown as PublicState), players: [p0, p1], power };
}

/** Both meter levels: two finite numbers, clamped to 0..POWER_MAX (power-meter spec §5). */
function parsePower(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => isNum(n))) return null;
  const clampLevel = (n: number): number => Math.min(POWER_MAX, Math.max(0, n));
  return [clampLevel(v[0] as number), clampLevel(v[1] as number)];
}

function parseReady(v: unknown): [boolean, boolean] | null {
  return Array.isArray(v) && v.length === 2 && isBool(v[0]) && isBool(v[1]) ? [v[0], v[1]] : null;
}

function parseFrame(m: Rec): NetMsg | null {
  if (!isInt(m.turn) || !isNum(m.τ)) return null;
  const frame: Extract<NetMsg, { type: 'frame' }> = { type: 'frame', turn: m.turn, τ: m.τ };
  if (m.ev !== undefined) {
    const ev = parseEvents(m.ev);
    if (!ev) return null;
    frame.ev = ev;
  }
  if (m.s !== undefined) {
    const s = parseState(m.s);
    if (!s) return null;
    frame.s = s;
  }
  return frame;
}

function parseFields(m: Rec): NetMsg | null {
  switch (m.type) {
    case 'hello': {
      const look = parseLook(m.look);
      if (!isInt(m.proto) || !isStr(m.app) || !isStr(m.name) || !look) return null;
      return { type: 'hello', proto: m.proto, app: m.app, name: sanitizeName(m.name), look };
    }
    case 'welcome': {
      const hostProfile = parseProfile(m.hostProfile);
      const config = parseConfig(m.config);
      if (!isInt(m.proto) || !hostProfile || !config) return null;
      return { type: 'welcome', proto: m.proto, hostProfile, config };
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
      const hostProfile = parseProfile(m.hostProfile);
      const guestProfile = parseProfile(m.guestProfile);
      return config && hostProfile && guestProfile && { type: 'start', config, hostProfile, guestProfile };
    }
    case 'input':
      if (!isInt(m.seq) || !isInt(m.turn) || !isKeyInput(m.k) || !isNum(m.τ)) return null;
      return { type: 'input', seq: m.seq, turn: m.turn, k: m.k, τ: m.τ };
    case 'clock':
      return isInt(m.turn) && isNum(m.τ) ? { type: 'clock', turn: m.turn, τ: m.τ } : null;
    case 'frame':
      return parseFrame(m);
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
 * Validates a received message: returns a clean copy (unknown fields dropped, names sanitized, look
 * indices clamped) or null if it is not an object, has an unknown type or bad fields, or its JSON
 * exceeds MAX_MSG_CHARS.
 */
export function parseMsg(raw: unknown): NetMsg | null {
  if (!isRec(raw)) return null;
  let chars: number;
  try {
    chars = JSON.stringify(raw).length;
  } catch {
    return null;
  }
  return chars > MAX_MSG_CHARS ? null : parseFields(raw);
}

/** parseMsg for a value whose size was already checked, so its JSON is not measured again. */
function parseSized(raw: unknown): NetMsg | null {
  return isRec(raw) ? parseFields(raw) : null;
}

/** The typing game's wire codec (spec §5.3): JSON strings, size-capped, validated by parseMsg's field checks. */
export const NET_CODEC: Codec<NetMsg> = jsonCodec(parseSized);

/** The wire form of `msg` with its size, or null with a `[bbt] frame too big` warning when it is over MAX_SEND_BYTES. */
export function encodeWithBytes(msg: NetMsg): EncodedMsg | null {
  return NET_CODEC.encode(msg);
}

/** The wire form of `msg` (its JSON), or null with a `[bbt] frame too big` warning when it is over MAX_SEND_BYTES. */
export function encodeMsg(msg: NetMsg): string | null {
  return encodeWithBytes(msg)?.json ?? null;
}

/**
 * A received wire message: a JSON string of at most MAX_SEND_BYTES characters (checked before it is
 * parsed; no sendable message is longer) whose value passes parseMsg's field checks. The string's
 * length is its size, so the value is not measured again. Anything else is null.
 */
export function decodeMsg(data: unknown): NetMsg | null {
  return NET_CODEC.decode(data);
}
