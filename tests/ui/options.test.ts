import { describe, expect, it } from 'vitest';
import type { Choice } from '../../src/ui/controls';
import {
  DEUCE_CHOICES,
  DISPLAY_CHOICES,
  FORMAT_CHOICES,
  PACE_CHOICES,
  PACK_CHOICES,
  SURFACE_CHOICES,
  valuesOf,
} from '../../src/ui/options';
import { DEFAULT_SETTINGS, isSettings, type Settings } from '../../src/ui/settings';

const LISTS: [keyof Settings, readonly Choice<unknown>[]][] = [
  ['format', FORMAT_CHOICES],
  ['pace', PACE_CHOICES],
  ['surface', SURFACE_CHOICES],
  ['wordPack', PACK_CHOICES],
  ['deuceRule', DEUCE_CHOICES],
  ['display', DISPLAY_CHOICES],
];

describe('option lists (one source for the menus and the settings validator)', () => {
  it('lists every value once, in menu order, Relaxed pace and Everyday words first', () => {
    expect(valuesOf(FORMAT_CHOICES)).toEqual(['tiebreak', 'short', 'full', 'bo3']);
    expect(valuesOf(PACE_CHOICES)).toEqual(['relaxed', 'normal', 'fast', 'lightning']);
    expect(valuesOf(SURFACE_CHOICES)).toEqual(['hard', 'clay', 'grass', 'dojo']);
    expect(valuesOf(PACK_CHOICES)).toEqual(['everyday', 'sports', 'dojo', 'mixed']);
    expect(valuesOf(DEUCE_CHOICES)).toEqual(['advantage', 'golden']);
    expect(valuesOf(DISPLAY_CHOICES)).toEqual(['pixel', 'fit']);
  });

  it.each(LISTS)('stored settings accept every %s the menus offer, and nothing else', (field, choices) => {
    for (const c of choices) expect(isSettings({ ...DEFAULT_SETTINGS, [field]: c.value })).toBe(true);
    expect(isSettings({ ...DEFAULT_SETTINGS, [field]: 'bogus' })).toBe(false);
  });
});
