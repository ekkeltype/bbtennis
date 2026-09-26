import { describe, expect, it } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import {
  DEFAULT_CAREER,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  highestBelt,
  isCareer,
  isProfile,
  isSettings,
  liveName,
  recordCareer,
  type Career,
} from '../../src/ui/settings';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** A copy of `base` with `patch` applied at the top level or one level down (`look`, `volumes`). */
const withField = (base: object, path: string, value: unknown): unknown => {
  const copy = clone(base) as Record<string, Record<string, unknown>>;
  const [a, b] = path.split('.') as [string, string | undefined];
  if (b === undefined) (copy as Record<string, unknown>)[a] = value;
  else copy[a]![b] = value;
  return copy;
};
const without = (base: object, key: string): unknown => {
  const copy = clone(base) as Record<string, unknown>;
  delete copy[key];
  return copy;
};

describe('defaults', () => {
  it('first vs-CPU setup: White belt, Relaxed, Tiebreak, Everyday words', () => {
    expect(DEFAULT_SETTINGS.cpuLevel).toBe(0);
    expect(CPU_LEVELS[DEFAULT_SETTINGS.cpuLevel]?.belt).toBe('white');
    expect(DEFAULT_SETTINGS.pace).toBe('relaxed');
    expect(DEFAULT_SETTINGS.format).toBe('tiebreak');
    expect(DEFAULT_SETTINGS.wordPack).toBe('everyday');
    expect(DEFAULT_SETTINGS.display).toBe('pixel');
    expect(DEFAULT_SETTINGS.trainingDone).toBe(false);
    expect(DEFAULT_SETTINGS.matchesPlayed).toBe(0);
  });

  it('every default passes its own validator and survives a JSON round trip', () => {
    expect(isSettings(clone(DEFAULT_SETTINGS))).toBe(true);
    expect(isProfile(clone(DEFAULT_PROFILE))).toBe(true);
    expect(isCareer(clone(DEFAULT_CAREER))).toBe(true);
  });

  it('a new career has one empty row per CPU level and no belts', () => {
    expect(DEFAULT_CAREER.perLevel).toHaveLength(CPU_LEVELS.length);
    expect(DEFAULT_CAREER.perLevel.every((r) => r.played === 0 && r.won === 0)).toBe(true);
    expect(DEFAULT_CAREER.bestWpm).toBe(0);
    expect(DEFAULT_CAREER.earned).toEqual([]);
  });
});

describe('isSettings rejects wrong shapes', () => {
  it.each([null, undefined, 42, 'settings', [], {}])('%j', (v) => {
    expect(isSettings(v)).toBe(false);
  });

  it.each(Object.keys(DEFAULT_SETTINGS))('a settings object without %s', (key) => {
    expect(isSettings(without(DEFAULT_SETTINGS, key))).toBe(false);
  });

  it.each([
    ['pace', 'slow'],
    ['wordPack', 'tennis'],
    ['deuceRule', 'sudden'],
    ['surface', 'ice'],
    ['format', 'bo5'],
    ['cpuLevel', 15],
    ['cpuLevel', -1],
    ['cpuLevel', 2.5],
    ['cpuLevel', '3'],
    ['volumes', null],
    ['volumes.master', 1.5],
    ['volumes.music', -0.1],
    ['volumes.sfx', '1'],
    ['volumes.sfx', null],
    ['umpireVoice', 'yes'],
    ['showWpm', 1],
    ['largeWords', null],
    ['reduceEffects', 'false'],
    ['display', 'big'],
    ['trainingDone', 0],
    ['matchesPlayed', -1],
    ['matchesPlayed', 0.5],
  ])('%s = %j', (path, value) => {
    expect(isSettings(withField(DEFAULT_SETTINGS, path, value))).toBe(false);
  });

  it('accepts every valid enum value', () => {
    for (const pace of ['relaxed', 'normal', 'fast', 'lightning']) expect(isSettings(withField(DEFAULT_SETTINGS, 'pace', pace))).toBe(true);
    for (const pack of ['everyday', 'sports', 'dojo', 'mixed']) expect(isSettings(withField(DEFAULT_SETTINGS, 'wordPack', pack))).toBe(true);
    for (const f of ['tiebreak', 'short', 'full', 'bo3']) expect(isSettings(withField(DEFAULT_SETTINGS, 'format', f))).toBe(true);
    for (const s of ['hard', 'clay', 'grass', 'dojo']) expect(isSettings(withField(DEFAULT_SETTINGS, 'surface', s))).toBe(true);
    expect(isSettings(withField(DEFAULT_SETTINGS, 'cpuLevel', 14))).toBe(true);
    expect(isSettings(withField(DEFAULT_SETTINGS, 'display', 'fit'))).toBe(true);
    expect(isSettings(withField(DEFAULT_SETTINGS, 'deuceRule', 'golden'))).toBe(true);
  });
});

describe('isProfile rejects wrong shapes', () => {
  it.each([null, {}, { name: 'ALEX' }, { look: DEFAULT_PROFILE.look }])('%j', (v) => {
    expect(isProfile(v)).toBe(false);
  });

  it.each([
    ['name', ''],
    ['name', 'ABCDEFGHIJKLM'],
    ['name', '<b>BOLD</b>'],
    ['name', 'Zoë'],
    ['name', ' ALEX'],
    ['name', 42],
    ['look', null],
    ['look.skin', 6],
    ['look.skin', -1],
    ['look.hairStyle', 5],
    ['look.hair', 8],
    ['look.shirt', 12],
    ['look.shorts', 1.5],
    ['look.headband', 12],
    ['look.headband', 'black'],
    ['look.racket', 6],
  ])('%s = %j', (path, value) => {
    expect(isProfile(withField(DEFAULT_PROFILE, path, value))).toBe(false);
  });

  it('a look without a headband field is rejected, but headband null (none) is fine', () => {
    const copy = clone(DEFAULT_PROFILE) as unknown as { look: Record<string, unknown> };
    delete copy.look['headband'];
    expect(isProfile(copy)).toBe(false);
    expect(isProfile(withField(DEFAULT_PROFILE, 'look.headband', null))).toBe(true);
    expect(isProfile(withField(DEFAULT_PROFILE, 'look.headband', 4))).toBe(true);
  });

  it('accepts any sanitised name', () => {
    expect(isProfile(withField(DEFAULT_PROFILE, 'name', "O'Neil-2 J.R"))).toBe(true);
  });
});

describe('isCareer rejects wrong shapes', () => {
  const rows = (n: number): { played: number; won: number }[] => Array.from({ length: n }, () => ({ played: 0, won: 0 }));

  it.each([
    null,
    {},
    { perLevel: rows(14), bestWpm: 0, earned: [] },
    { perLevel: rows(16), bestWpm: 0, earned: [] },
    { perLevel: [{ played: 1, won: 2 }, ...rows(14)], bestWpm: 0, earned: [] },
    { perLevel: [{ played: -1, won: 0 }, ...rows(14)], bestWpm: 0, earned: [] },
    { perLevel: [{ played: 1.5, won: 0 }, ...rows(14)], bestWpm: 0, earned: [] },
    { perLevel: [null, ...rows(14)], bestWpm: 0, earned: [] },
    { perLevel: rows(15), bestWpm: -3, earned: [] },
    { perLevel: rows(15), bestWpm: '50', earned: [] },
    { perLevel: rows(15), bestWpm: 0, earned: ['purple'] },
    { perLevel: rows(15), bestWpm: 0, earned: ['green', 'green'] },
    { perLevel: rows(15), bestWpm: 0, earned: 'green' },
  ])('%j', (v) => {
    expect(isCareer(v)).toBe(false);
  });

  it('accepts a played career', () => {
    expect(isCareer({ perLevel: [{ played: 3, won: 2 }, ...rows(14)], bestWpm: 48.5, earned: ['white', 'yellow'] })).toBe(true);
  });
});

describe('recordCareer', () => {
  it("earns 'green' when beating level 6 (the Green belt milestone)", () => {
    const c = recordCareer(clone(DEFAULT_CAREER), 6, true, 40);
    expect(c.earned).toEqual(['green']);
    expect(highestBelt(c)).toBe('green');
  });

  it('earns nothing when beating level 7 (Green belt, 1 stripe: not a milestone)', () => {
    const c = recordCareer(clone(DEFAULT_CAREER), 7, true, 40);
    expect(c.earned).toEqual([]);
    expect(highestBelt(c)).toBeNull();
  });

  it('earns nothing for a lost milestone match', () => {
    expect(recordCareer(clone(DEFAULT_CAREER), 6, false, 40).earned).toEqual([]);
  });

  it('earns each belt once; the dan grades count as the black belt', () => {
    let c: Career = clone(DEFAULT_CAREER);
    c = recordCareer(c, 0, true, 20);
    c = recordCareer(c, 0, true, 20);
    c = recordCareer(c, 13, true, 90);
    expect(c.earned).toEqual(['white', 'black']);
  });

  it('counts played and won per level and keeps the best WPM', () => {
    let c: Career = clone(DEFAULT_CAREER);
    c = recordCareer(c, 3, false, 41.5);
    c = recordCareer(c, 3, true, 38);
    c = recordCareer(c, 9, false, 55);
    expect(c.perLevel[3]).toEqual({ played: 2, won: 1 });
    expect(c.perLevel[9]).toEqual({ played: 1, won: 0 });
    expect(c.bestWpm).toBe(55);
    expect(isCareer(c)).toBe(true);
  });

  it('does not change the career it is given', () => {
    const before = clone(DEFAULT_CAREER);
    const snapshot = JSON.stringify(before);
    recordCareer(before, 6, true, 80);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('ignores a non-finite or negative WPM for the best WPM', () => {
    const c = recordCareer({ ...clone(DEFAULT_CAREER), bestWpm: 30 }, 1, true, Number.NaN);
    expect(c.bestWpm).toBe(30);
    expect(recordCareer(c, 1, true, -5).bestWpm).toBe(30);
  });

  it('returns the career unchanged for a level outside 0..14', () => {
    const c = clone(DEFAULT_CAREER);
    expect(recordCareer(c, 15, true, 50)).toEqual(c);
    expect(recordCareer(c, 2.5, true, 50)).toEqual(c);
  });
});

describe('highestBelt', () => {
  const career = (earned: string[]): Career => ({ ...clone(DEFAULT_CAREER), earned });

  it.each([
    [[], null],
    [['white'], 'white'],
    [['green', 'white'], 'green'],
    [['yellow', 'brown', 'green'], 'brown'],
    [['black', 'white'], 'black'],
  ] as const)('%j → %s', (earned, belt) => {
    expect(highestBelt(career([...earned]))).toBe(belt);
  });
});

describe('liveName (name field sanitisation while typing)', () => {
  it.each([
    ['Alex', 'Alex'],
    ['<b>Al</b>', 'bAlb'],
    ['Zoë 😀', 'Zo '],
    ['  Bo  b', 'Bo b'],
    ['ABCDEFGHIJKLMNOP', 'ABCDEFGHIJKL'],
    ["O'Neil-2 J.R", "O'Neil-2 J.R"],
    ['', ''],
  ])('%j → %j', (typed, shown) => {
    expect(liveName(typed)).toBe(shown);
  });
});
