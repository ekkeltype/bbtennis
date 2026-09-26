import type { DeuceRule, FormatId, PaceId, Surface, WordPackId } from '../core/types';
import type { Choice } from './controls';
import type { Settings } from './settings';

/** Match formats with what it takes to win (spec §3.6). */
export const FORMAT_CHOICES: readonly Choice<FormatId>[] = [
  { value: 'tiebreak', label: 'TIEBREAK', hint: 'FIRST TO 7' },
  { value: 'short', label: 'SHORT SET', hint: 'FIRST TO 4 GAMES' },
  { value: 'full', label: 'FULL SET', hint: 'FIRST TO 6 GAMES' },
  { value: 'bo3', label: 'BEST OF 3', hint: 'SHORT SETS' },
];
/** Pace presets with the typing speed each suits (spec §3.9). */
export const PACE_CHOICES: readonly Choice<PaceId>[] = [
  { value: 'relaxed', label: 'RELAXED', hint: '30 WPM' },
  { value: 'normal', label: 'NORMAL', hint: '50 WPM' },
  { value: 'fast', label: 'FAST', hint: '70 WPM' },
  { value: 'lightning', label: 'LIGHTNING', hint: '90 WPM' },
];
/** Court surfaces (cosmetic). */
export const SURFACE_CHOICES: readonly Choice<Surface>[] = [
  { value: 'hard', label: 'HARD' },
  { value: 'clay', label: 'CLAY' },
  { value: 'grass', label: 'GRASS' },
  { value: 'dojo', label: 'DOJO' },
];
/** Word packs (spec §3.10), Everyday first. */
export const PACK_CHOICES: readonly Choice<WordPackId>[] = [
  { value: 'everyday', label: 'EVERYDAY' },
  { value: 'sports', label: 'SPORTS' },
  { value: 'dojo', label: 'DOJO' },
  { value: 'mixed', label: 'MIXED' },
];
/** Deuce handling (spec §3.6). */
export const DEUCE_CHOICES: readonly Choice<DeuceRule>[] = [
  { value: 'advantage', label: 'ADVANTAGE' },
  { value: 'golden', label: 'GOLDEN POINT' },
];
/** Display scaling (spec §4.1). */
export const DISPLAY_CHOICES: readonly Choice<Settings['display']>[] = [
  { value: 'pixel', label: 'PIXEL-PERFECT' },
  { value: 'fit', label: 'FIT' },
];

/** The values of `choices`, in order: the list the settings validator and the attract demo draw from. */
export function valuesOf<T>(choices: readonly Choice<T>[]): T[] {
  return choices.map((c) => c.value);
}
