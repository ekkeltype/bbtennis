import { CPU_LEVELS, isMilestone } from '../core/cpu';
import { NAME_CHARS, NAME_MAX, sanitizeName } from '../core/text';
import type { DeuceRule, FormatId, Look, PaceId, Profile, Surface, WordPackId } from '../core/types';
import { RAMPS } from '../render/palette';
import { HAIR_STYLES } from '../render/sprites/parts';

export type { Profile } from '../core/types';

/** Belt colours in rank order, lowest first (spec §3.8). */
export type Belt = 'white' | 'yellow' | 'green' | 'brown' | 'black';
/** Every belt, lowest first. */
export const BELTS: readonly Belt[] = ['white', 'yellow', 'green', 'brown', 'black'];

/**
 * Everything the player chooses that is kept between visits: the default/last match options (the
 * vs-CPU setup remembers its last choices here), volumes 0..1, display preferences, and progress flags.
 */
export interface Settings {
  pace: PaceId;
  wordPack: WordPackId;
  deuceRule: DeuceRule;
  surface: Surface;
  format: FormatId;
  cpuLevel: number;
  volumes: { master: number; music: number; sfx: number };
  umpireVoice: boolean;
  showWpm: boolean;
  largeWords: boolean;
  reduceEffects: boolean;
  display: 'pixel' | 'fit';
  trainingDone: boolean;
  matchesPlayed: number;
}

/** Local vs-CPU record (spec §3.11): matches played/won per CPU level, best average WPM, belts earned. */
export interface Career { perLevel: { played: number; won: number }[]; bestWpm: number; earned: string[] }

/** Settings on a first visit: the first vs-CPU setup is White belt, Relaxed pace, Tiebreak (spec §3.12). */
export const DEFAULT_SETTINGS: Settings = {
  pace: 'relaxed',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  surface: 'hard',
  format: 'tiebreak',
  cpuLevel: 0,
  volumes: { master: 0.8, music: 0.6, sfx: 0.8 },
  umpireVoice: true,
  showWpm: true,
  largeWords: false,
  reduceEffects: false,
  display: 'pixel',
  trainingDone: false,
  matchesPlayed: 0,
};

/** A new player: no headband until a belt is earned. */
export const DEFAULT_PROFILE: Profile = {
  name: 'PLAYER',
  look: { skin: 1, hairStyle: 0, hair: 1, shirt: 6, shorts: 0, headband: null, racket: 0 },
};

/** A career with no matches played. */
export const DEFAULT_CAREER: Career = {
  perLevel: CPU_LEVELS.map(() => ({ played: 0, won: 0 })),
  bestWpm: 0,
  earned: [],
};

const PACES: readonly PaceId[] = ['relaxed', 'normal', 'fast', 'lightning'];
const PACKS: readonly WordPackId[] = ['everyday', 'sports', 'dojo', 'mixed'];
const DEUCE_RULES: readonly DeuceRule[] = ['advantage', 'golden'];
const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];
const FORMATS: readonly FormatId[] = ['tiebreak', 'short', 'full', 'bo3'];
const DISPLAYS: readonly Settings['display'][] = ['pixel', 'fit'];

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T>(values: readonly T[], v: unknown): v is T => values.includes(v as T);
/** An integer in lo..hi. */
const intIn = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const unit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** True for a complete, well-formed Settings object (as stored JSON). */
export function isSettings(v: unknown): v is Settings {
  if (!isObject(v) || !isObject(v['volumes'])) return false;
  const vol = v['volumes'];
  return (
    oneOf(PACES, v['pace']) &&
    oneOf(PACKS, v['wordPack']) &&
    oneOf(DEUCE_RULES, v['deuceRule']) &&
    oneOf(SURFACES, v['surface']) &&
    oneOf(FORMATS, v['format']) &&
    intIn(v['cpuLevel'], 0, CPU_LEVELS.length - 1) &&
    unit(vol['master']) &&
    unit(vol['music']) &&
    unit(vol['sfx']) &&
    typeof v['umpireVoice'] === 'boolean' &&
    typeof v['showWpm'] === 'boolean' &&
    typeof v['largeWords'] === 'boolean' &&
    typeof v['reduceEffects'] === 'boolean' &&
    oneOf(DISPLAYS, v['display']) &&
    typeof v['trainingDone'] === 'boolean' &&
    count(v['matchesPlayed'])
  );
}

/** True for a look whose every index is inside its ramp or style table (headband may be null = none). */
export function isLook(v: unknown): v is Look {
  if (!isObject(v) || !('headband' in v)) return false;
  const cloth = RAMPS.cloth.length - 1;
  return (
    intIn(v['skin'], 0, RAMPS.skin.length - 1) &&
    intIn(v['hairStyle'], 0, HAIR_STYLES.length - 1) &&
    intIn(v['hair'], 0, RAMPS.hair.length - 1) &&
    intIn(v['shirt'], 0, cloth) &&
    intIn(v['shorts'], 0, cloth) &&
    (v['headband'] === null || intIn(v['headband'], 0, cloth)) &&
    intIn(v['racket'], 0, RAMPS.racket.length - 1)
  );
}

/** True for a profile with an already-sanitised name (spec §4.6: ≤ 12 font glyphs) and a valid look. */
export function isProfile(v: unknown): v is Profile {
  return isObject(v) && typeof v['name'] === 'string' && sanitizeName(v['name']) === v['name'] && isLook(v['look']);
}

/** True for a career with one {played, won ≤ played} row per CPU level, a finite best WPM ≥ 0 and distinct known belts. */
export function isCareer(v: unknown): v is Career {
  if (!isObject(v)) return false;
  const { perLevel, bestWpm, earned } = v;
  return (
    Array.isArray(perLevel) &&
    perLevel.length === CPU_LEVELS.length &&
    perLevel.every((r) => isObject(r) && count(r['played']) && count(r['won']) && r['won'] <= r['played']) &&
    typeof bestWpm === 'number' &&
    Number.isFinite(bestWpm) &&
    bestWpm >= 0 &&
    Array.isArray(earned) &&
    earned.every((b) => oneOf(BELTS, b)) &&
    new Set(earned).size === earned.length
  );
}

/**
 * The career after a finished vs-CPU match at `level`: one more played (and won) there, the best
 * average WPM kept, and on a win over a milestone level (a belt with no stripes, or a dan grade) that
 * belt earned (spec §3.11). Returns a new object; an invalid level leaves the career as it was.
 */
export function recordCareer(c: Career, level: number, won: boolean, wpm: number): Career {
  const info = Number.isInteger(level) ? CPU_LEVELS[level] : undefined;
  if (info === undefined) return c;
  const perLevel = c.perLevel.map((r, i) => (i === level ? { played: r.played + 1, won: r.won + (won ? 1 : 0) } : { ...r }));
  const bestWpm = Number.isFinite(wpm) && wpm > c.bestWpm ? wpm : c.bestWpm;
  const earned = won && isMilestone(level) && !c.earned.includes(info.belt) ? [...c.earned, info.belt] : [...c.earned];
  return { perLevel, bestWpm, earned };
}

/** The highest belt earned so far, or null. */
export function highestBelt(c: Career): Belt | null {
  for (let i = BELTS.length - 1; i >= 0; i--) {
    const belt = BELTS[i];
    if (belt !== undefined && c.earned.includes(belt)) return belt;
  }
  return null;
}

/**
 * The name field's text while typing: characters outside the font's name set are dropped, runs of
 * spaces collapse, no leading space, at most NAME_MAX characters. `sanitizeName` finishes it on save.
 */
export function liveName(s: string): string {
  let kept = '';
  for (const ch of s) if (NAME_CHARS.includes(ch)) kept += ch;
  return kept.replace(/ {2,}/g, ' ').replace(/^ +/, '').slice(0, NAME_MAX);
}
