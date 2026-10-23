import { sanitizeName } from '../core/text';
import type { DeuceRule, FormatId, Look, PaceId, Profile, Surface } from '../core/types';

/** A received JSON object, before its fields are checked. */
export type Rec = Record<string, unknown>;

/** The match options both games share, as key tables for `isKey`. */
export const FORMATS: Record<FormatId, true> = { tiebreak: true, short: true, full: true, bo3: true };
export const PACES: Record<PaceId, true> = { relaxed: true, normal: true, fast: true, lightning: true };
export const SURFACES: Record<Surface, true> = { hard: true, clay: true, grass: true, dojo: true };
export const DEUCE_RULES: Record<DeuceRule, true> = { advantage: true, golden: true };
/** Why a host turns a guest away (spec §5.3). */
export const REJECT_REASONS = { version: true, full: true, 'in-match': true } as const;

/** Highest index of each Look field (spec §4.1). */
const LOOK_MAX: Record<keyof Look, number> = { skin: 5, hairStyle: 4, hair: 7, shirt: 11, shorts: 11, headband: 11, racket: 5 };

export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
export const isKey = <K extends string>(table: Record<K, true>, v: unknown): v is K => isStr(v) && Object.hasOwn(table, v);

const clampIndex = (v: number, max: number): number => Math.min(max, Math.max(0, Math.floor(v)));

/** A received look with every index clamped to its range, or null when a field is missing or not a number. */
export function parseLook(v: unknown): Look | null {
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

/** A received name and look: the name sanitized, the look clamped (parseLook); null when malformed. */
export function parseProfile(v: unknown): Profile | null {
  if (!isRec(v) || !isStr(v.name)) return null;
  const look = parseLook(v.look);
  return look && { name: sanitizeName(v.name), look };
}
