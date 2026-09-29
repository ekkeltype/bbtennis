import { POWER_MAX } from '../core/power';
import { sanitizeName } from '../core/text';
import type {
  DeuceRule, FormatId, GameEvent, Look, MatchConfig, PaceId, PlayerInfo, Profile, PublicState, Surface, TrainingFlags, WordPackId,
} from '../core/types';

/** Protocol version; bump on any change to the protocol, PublicState, TurnRunner or key classification (spec §5.3). */
export const PROTO = 2;

/** Application id sent in `hello` and `reject`. */
export const APP_ID = 'bbtennis';

/** parseMsg drops a value whose JSON is longer than this many characters (spec §5.3). */
export const MAX_MSG_CHARS = 32 * 1024;

/**
 * Largest message a transport sends, in UTF-8 bytes of its JSON (see msgBytes); transports drop a
 * larger one (see encodeMsg). It is also the most characters decodeMsg accepts in a received string:
 * a string never has more characters than UTF-8 bytes, so every sendable message passes. Well under
 * the 64 KiB a WebRTC data channel always accepts.
 */
export const MAX_SEND_BYTES = 32000;

const utf8 = new TextEncoder();

const jsonBytes = (json: string): number => utf8.encode(json).byteLength;

/** Size of `msg` on the wire: the UTF-8 byte length of its JSON. */
export function msgBytes(msg: NetMsg): number {
  return jsonBytes(JSON.stringify(msg));
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

type Rec = Record<string, unknown>;

const FORMATS: Record<FormatId, true> = { tiebreak: true, short: true, full: true, bo3: true };
const PACES: Record<PaceId, true> = { relaxed: true, normal: true, fast: true, lightning: true };
const SURFACES: Record<Surface, true> = { hard: true, clay: true, grass: true, dojo: true };
const WORD_PACKS: Record<WordPackId, true> = { everyday: true, sports: true, dojo: true, mixed: true };
const DEUCE_RULES: Record<DeuceRule, true> = { advantage: true, golden: true };
const REJECT_REASONS = { version: true, full: true, 'in-match': true } as const;

/** Highest index of each Look field (spec §4.1). */
const LOOK_MAX: Record<keyof Look, number> = { skin: 5, hairStyle: 4, hair: 7, shirt: 11, shorts: 11, headband: 11, racket: 5 };

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isKey = <K extends string>(table: Record<K, true>, v: unknown): v is K => isStr(v) && Object.hasOwn(table, v);
const isStrGrid = (v: unknown): v is string[][] => Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every(isStr));

/** A guest key: one lowercase letter or 'toss' (spec §4.5). */
const isKeyInput = (v: unknown): v is string => isStr(v) && (v === 'toss' || /^[a-z]$/.test(v));

const clampIndex = (v: number, max: number): number => Math.min(max, Math.max(0, Math.floor(v)));

function parseLook(v: unknown): Look | null {
  if (!isRec(v)) return null;
  const { skin, hairStyle, hair, shirt, shorts, headband, racket } = v;
  if (!isNum(skin) || !isNum(hairStyle) || !isNum(hair) || !isNum(shirt) || !isNum(shorts) || !isNum(racket)) return null;
  if (headband !== null && !isNum(headband)) return null;
  return {
    skin: clampIndex(skin, LOOK_MAX.skin),
    hairStyle: clampIndex(hairStyle, LOOK_MAX.hairStyle),
    hair: clampIndex(hair, LOOK_MAX.hair),
    shirt: clampIndex(shirt, LOOK_MAX.shirt),
    shorts: clampIndex(shorts, LOOK_MAX.shorts),
    headband: headband === null ? null : clampIndex(headband, LOOK_MAX.headband),
    racket: clampIndex(racket, LOOK_MAX.racket),
  };
}

function parseProfile(v: unknown): Profile | null {
  if (!isRec(v) || !isStr(v.name)) return null;
  const look = parseLook(v.look);
  return look && { name: sanitizeName(v.name), look };
}

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

/** A message in wire form: its JSON and the UTF-8 byte length of that JSON. */
export interface EncodedMsg { json: string; bytes: number }

/** The wire form of `msg` with its size, or null with a `[bbt] frame too big` warning when it is over MAX_SEND_BYTES. */
export function encodeWithBytes(msg: NetMsg): EncodedMsg | null {
  const json = JSON.stringify(msg);
  const bytes = jsonBytes(json);
  if (bytes <= MAX_SEND_BYTES) return { json, bytes };
  console.warn('[bbt] frame too big', bytes);
  return null;
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
  if (typeof data !== 'string' || data.length > MAX_SEND_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  return parseSized(raw);
}
