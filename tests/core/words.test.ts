import { describe, expect, it } from 'vitest';
import { seedRng } from '../../src/core/rng';
import { TUNING } from '../../src/core/tuning';
import { TIERS, type PickerState, type RngState, type Tier, type WordOption, type WordPackId } from '../../src/core/types';
import { PACKS, packWords, tierOfLength } from '../../src/core/words/lists';
import { QWERTY_ADJ, createPicker, initialsOk, pickFixed, pickTriple, toOption } from '../../src/core/words/picker';

const MIN_WORDS: Record<Tier, number> = { easy: 120, medium: 120, hard: 80 };
const LENGTHS: Record<Tier, [number, number]> = { easy: [3, 5], medium: [6, 9], hard: [10, 14] };
const HISTORY = TUNING.words.historySize;

const duplicatesOf = (words: readonly string[]): string[] => words.filter((w, i) => words.indexOf(w) !== i);
const sortedLetters = (s: string | undefined): string => [...(s ?? '')].sort().join('');
const wordsOf = (options: readonly WordOption[]): string[] => options.map((o) => o.word);

/** Independent oracle for the initials rule, so property tests do not trust initialsOk. */
function initialsClash(words: readonly string[]): boolean {
  const initials = words.map((w) => w.charAt(0));
  return initials.some((a, i) => initials.some((b, j) => j !== i && (a === b || (QWERTY_ADJ[a] ?? '').includes(b))));
}

describe('word packs', () => {
  for (const pack of ['tennis', 'everyday'] as const) {
    for (const tier of TIERS) {
      describe(`${pack} ${tier}`, () => {
        const words = PACKS[pack][tier];
        const [min, max] = LENGTHS[tier];

        it(`has at least ${MIN_WORDS[tier]} words`, () => {
          expect(words.length).toBeGreaterThanOrEqual(MIN_WORDS[tier]);
        });

        it('uses lowercase a–z only', () => {
          expect(words.filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
        });

        it(`has only ${min}–${max}-letter words`, () => {
          expect(words.filter((w) => w.length < min || w.length > max)).toEqual([]);
        });

        it('has no duplicates', () => {
          expect(duplicatesOf(words)).toEqual([]);
        });

        it('has at least 12 distinct initials', () => {
          expect(new Set(words.map((w) => w.charAt(0))).size).toBeGreaterThanOrEqual(12);
        });
      });
    }
  }
});

describe('tierOfLength', () => {
  it('maps lengths to tiers by the spec bounds (easy 3–5, medium 6–9, hard 10–14)', () => {
    const lengths = [0, 2, 3, 5, 6, 9, 10, 14, 15];
    expect(lengths.map((n) => tierOfLength(n))).toEqual([null, null, 'easy', 'easy', 'medium', 'medium', 'hard', 'hard', null]);
  });
});

describe('packWords', () => {
  it('returns the tennis and everyday lists as defined', () => {
    for (const tier of TIERS) {
      expect(packWords('tennis', tier)).toEqual(PACKS.tennis[tier]);
      expect(packWords('everyday', tier)).toEqual(PACKS.everyday[tier]);
    }
  });

  it('mixed is the deduplicated union of both packs', () => {
    for (const tier of TIERS) {
      const mixed = packWords('mixed', tier);
      expect(duplicatesOf(mixed)).toEqual([]);
      expect(new Set(mixed)).toEqual(new Set([...PACKS.tennis[tier], ...PACKS.everyday[tier]]));
    }
  });
});

describe('QWERTY_ADJ', () => {
  it('has an entry for exactly the letters a–z', () => {
    expect(Object.keys(QWERTY_ADJ).sort().join('')).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('is symmetric and never lists a letter as its own neighbour', () => {
    const broken: string[] = [];
    for (const [a, near] of Object.entries(QWERTY_ADJ)) {
      for (const b of near) if (b === a || !(QWERTY_ADJ[b] ?? '').includes(a)) broken.push(`${a}->${b}`);
    }
    expect(broken).toEqual([]);
  });

  it('includes same-row edges and the touching keys in the staggered rows above and below', () => {
    expect(sortedLetters(QWERTY_ADJ.s)).toBe('adewxz');
    expect(QWERTY_ADJ.q).toContain('w');
    expect(QWERTY_ADJ.q).toContain('a');
    expect(sortedLetters(QWERTY_ADJ.q)).toBe('aw');
    expect(sortedLetters(QWERTY_ADJ.g)).toBe('bfhtvy');
    expect(sortedLetters(QWERTY_ADJ.p)).toBe('lo');
    expect(sortedLetters(QWERTY_ADJ.m)).toBe('jkn');
    expect(sortedLetters(QWERTY_ADJ.z)).toBe('asx');
  });
});

describe('initialsOk', () => {
  it('rejects adjacent initials', () => {
    expect(initialsOk(['sun', 'dart', 'xylophones'])).toBe(false);
    expect(initialsOk(['ball', 'network', 'xenophobic'])).toBe(false);
  });

  it('rejects a shared initial', () => {
    expect(initialsOk(['ball', 'backhand', 'tournament'])).toBe(false);
  });

  it('accepts distinct, pairwise non-adjacent initials', () => {
    expect(initialsOk(['ball', 'topspin', 'quarterfinal'])).toBe(true);
  });
});

describe('createPicker', () => {
  it('starts with an empty history and zeroed training cursors', () => {
    expect(createPicker()).toEqual({ history: [], fixedServe: 0, fixedChoice: 0 });
  });
});

describe('pickTriple', () => {
  for (const pack of ['tennis', 'everyday', 'mixed'] as const) {
    it(`${pack}: 2,000 picks obey tiers, initials and the ${HISTORY}-word history`, () => {
      const rng = seedRng(20260926);
      const picker = createPicker();
      const offered: string[] = [];
      const problems: string[] = [];
      for (let i = 0; i < 2000; i++) {
        const recent = offered.slice(-HISTORY);
        const options = pickTriple(rng, picker, pack);
        const words = wordsOf(options);
        const label = `pick ${i} [${words.join(' ')}]`;
        if (options.map((o) => o.tier).join() !== TIERS.join()) problems.push(`${label}: tiers`);
        if (options.some((o) => o.len !== o.word.length)) problems.push(`${label}: len`);
        if (options.some((o) => !packWords(pack, o.tier).includes(o.word))) problems.push(`${label}: not in pack`);
        if (initialsClash(words)) problems.push(`${label}: initials`);
        if (words.some((w) => recent.includes(w))) problems.push(`${label}: repeats one of the last ${HISTORY}`);
        offered.push(...words);
        if (picker.history.join() !== offered.slice(-HISTORY).join()) problems.push(`${label}: history`);
      }
      expect(problems).toEqual([]);
      expect(picker.history).toHaveLength(HISTORY);
    });
  }

  it('records the three offered words in history, newest last', () => {
    const picker = createPicker();
    const words = wordsOf(pickTriple(seedRng(3), picker, 'tennis'));
    expect(picker.history).toEqual(words);
  });

  it('never returns avoided words', () => {
    const avoid = TIERS.flatMap((tier) => PACKS.everyday[tier].filter((_, i) => i % 2 === 0));
    const rng = seedRng(7);
    const picker = createPicker();
    const returned: string[] = [];
    for (let i = 0; i < 2000; i++) {
      returned.push(...wordsOf(pickTriple(rng, picker, 'everyday', avoid)).filter((w) => avoid.includes(w)));
    }
    expect(returned).toEqual([]);
  });

  it('relaxes only the history rule when every allowed word was offered recently', () => {
    const allowedEasy = PACKS.tennis.easy.slice(0, 2);
    const avoid = PACKS.tennis.easy.slice(2);
    const rng = seedRng(99);
    const picker = createPicker();
    let repeats = 0;
    for (let i = 0; i < 50; i++) {
      const recent = [...picker.history];
      const words = wordsOf(pickTriple(rng, picker, 'tennis', avoid));
      expect(allowedEasy, `pick ${i}`).toContain(words[0]);
      expect(initialsClash(words), `pick ${i}: ${words.join(' ')}`).toBe(false);
      if (words.some((w) => recent.includes(w))) repeats++;
      expect(picker.history.length).toBeLessThanOrEqual(HISTORY);
    }
    expect(repeats).toBeGreaterThan(0);
  });

  it('throws when no triple can satisfy the avoid and initials rules', () => {
    expect(() => pickTriple(seedRng(1), createPicker(), 'tennis', PACKS.tennis.easy)).toThrow(/pickTriple/);
  });
});

describe('pickTriple determinism', () => {
  const run = (rng: RngState, picker: PickerState, pack: WordPackId, n: number): string[] =>
    Array.from({ length: n }, () => wordsOf(pickTriple(rng, picker, pack)).join(' '));

  it('gives the same sequence for the same seed and picker state', () => {
    expect(run(seedRng(42), createPicker(), 'mixed', 300)).toEqual(run(seedRng(42), createPicker(), 'mixed', 300));
  });

  it('resumes identically from a JSON round-trip of rng and picker', () => {
    const rng = seedRng(42);
    const picker = createPicker();
    run(rng, picker, 'tennis', 50);
    const rngCopy = JSON.parse(JSON.stringify(rng)) as RngState;
    const pickerCopy = JSON.parse(JSON.stringify(picker)) as PickerState;
    expect(run(rngCopy, pickerCopy, 'tennis', 100)).toEqual(run(rng, picker, 'tennis', 100));
  });

  it('gives different sequences for different seeds', () => {
    expect(run(seedRng(1), createPicker(), 'tennis', 20)).not.toEqual(run(seedRng(2), createPicker(), 'tennis', 20));
  });
});

describe('pickFixed', () => {
  const list = [
    ['ball', 'topspin', 'quarterfinal'],
    ['net', 'backhand', 'tournament'],
  ];

  it('returns the next triple as options', () => {
    expect(pickFixed(createPicker(), list, 'serve')).toEqual([
      { word: 'ball', len: 4, tier: 'easy' },
      { word: 'topspin', len: 7, tier: 'medium' },
      { word: 'quarterfinal', len: 12, tier: 'hard' },
    ]);
  });

  it('cycles the list with independent serve and choice cursors', () => {
    const picker = createPicker();
    expect(wordsOf(pickFixed(picker, list, 'serve'))).toEqual(list[0]);
    expect(wordsOf(pickFixed(picker, list, 'serve'))).toEqual(list[1]);
    expect(wordsOf(pickFixed(picker, list, 'choice'))).toEqual(list[0]);
    expect(wordsOf(pickFixed(picker, list, 'serve'))).toEqual(list[0]);
    expect(wordsOf(pickFixed(picker, list, 'choice'))).toEqual(list[1]);
    expect(wordsOf(pickFixed(picker, list, 'choice'))).toEqual(list[0]);
  });

  it('leaves the random-pick history untouched', () => {
    const picker = createPicker();
    pickFixed(picker, list, 'serve');
    expect(picker.history).toEqual([]);
  });

  it('throws on an empty list', () => {
    expect(() => pickFixed(createPicker(), [], 'serve')).toThrow(/pickFixed/);
  });
});

describe('toOption', () => {
  it('computes length and tier', () => {
    expect(toOption('ball')).toEqual({ word: 'ball', len: 4, tier: 'easy' });
    expect(toOption('topspin')).toEqual({ word: 'topspin', len: 7, tier: 'medium' });
    expect(toOption('serveandvolley')).toEqual({ word: 'serveandvolley', len: 14, tier: 'hard' });
  });

  it('throws on anything but a 3–14-letter lowercase a–z word', () => {
    for (const bad of ['Ball', '', 'ab', 'abcdefghijklmno', 'ball!', 'ba ll', 'café']) {
      expect(() => toOption(bad), bad).toThrow();
    }
  });
});
