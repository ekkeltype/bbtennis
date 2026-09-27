import { describe, expect, it } from 'vitest';
import { seedRng } from '../../src/core/rng';
import { TUNING } from '../../src/core/tuning';
import { ALL_TIERS, TIERS, type PickerState, type RngState, type Tier, type WordOption, type WordPackId } from '../../src/core/types';
import { MISLEADING_WORDS, PACKS, packWords, tierOfLength } from '../../src/core/words/lists';
import { QWERTY_ADJ, createPicker, initialsOk, pickFixed, pickTriple, toOption } from '../../src/core/words/picker';

const MIN_WORDS: Record<Tier, number> = { easy: 120, medium: 120, hard: 80, insane: 60 };
const LENGTHS: Record<Tier, [number, number]> = { easy: [2, 4], medium: [5, 7], hard: [8, 11], insane: [12, 15] };
const HISTORY = TUNING.words.historySize;

/** Every WordPackId, as a record so the typecheck fails if the union gains or loses a pack. */
const PACK_FLAGS: Record<WordPackId, true> = { everyday: true, sports: true, dojo: true, mixed: true };
const PACK_IDS = Object.keys(PACK_FLAGS) as WordPackId[];

/** Blocklist entries the spec and brief require (spec §3.10); the exported set may hold more forms. */
const REQUIRED_MISLEADING = `
  forehand backhand lob lobs volley volleys smash slice topspin backspin underspin dropshot drop crosscourt
  overhead ace aces winner fault out net left right wide short deep long high low middle center centre corner
  line baseline sideline down across straight inside outside return serve passingshot groundstroke approach
  half volleying lobbed smashed sliced
`.trim().split(/\s+/);

/** Stems no pack word may contain anywhere; short stems such as 'lob' are exact-match only (so 'lobster' is fine). */
const MISLEADING_STEMS = ['forehand', 'backhand', 'volley', 'topspin', 'backspin', 'crosscourt', 'dropshot', 'overhead'];

const duplicatesOf = (words: readonly string[]): string[] => words.filter((w, i) => words.indexOf(w) !== i);
const sortedLetters = (s: string | undefined): string => [...(s ?? '')].sort().join('');
const wordsOf = (options: readonly WordOption[]): string[] => options.map((o) => o.word);

/** Independent oracle for the initials rule, so property tests do not trust initialsOk. */
function initialsClash(words: readonly string[]): boolean {
  const initials = words.map((w) => w.charAt(0));
  return initials.some((a, i) => initials.some((b, j) => j !== i && (a === b || (QWERTY_ADJ[a] ?? '').includes(b))));
}

describe('word packs', () => {
  for (const pack of PACK_IDS) {
    for (const tier of ALL_TIERS) {
      describe(`${pack} ${tier}`, () => {
        const words = packWords(pack, tier);
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

describe('misleading words', () => {
  it('blocks every shot, stroke, spin, outcome and direction word the spec names', () => {
    expect(REQUIRED_MISLEADING.filter((w) => !MISLEADING_WORDS.has(w))).toEqual([]);
  });

  it('holds only lowercase a–z words, so exact matches against pack words work', () => {
    expect([...MISLEADING_WORDS].filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
  });

  for (const pack of PACK_IDS) {
    const words = ALL_TIERS.flatMap((tier) => packWords(pack, tier));

    it(`${pack}: no word is on the blocklist`, () => {
      expect(words.filter((w) => MISLEADING_WORDS.has(w))).toEqual([]);
    });

    it(`${pack}: no word contains a stroke, spin or direction stem`, () => {
      expect(words.filter((w) => MISLEADING_STEMS.some((stem) => w.includes(stem)))).toEqual([]);
    });
  }
});

describe('tierOfLength', () => {
  it('maps lengths to tiers by the bands (easy 2–4, medium 5–7, hard 8–11, insane 12–15)', () => {
    const lengths = [0, 1, 2, 4, 5, 7, 8, 11, 12, 15, 16];
    expect(lengths.map((n) => tierOfLength(n))).toEqual([
      null, null, 'easy', 'easy', 'medium', 'medium', 'hard', 'hard', 'insane', 'insane', null,
    ]);
  });
});

describe('packWords', () => {
  it('defines the everyday, sports and dojo packs only (no tennis pack; mixed is derived)', () => {
    expect(Object.keys(PACKS).sort()).toEqual(['dojo', 'everyday', 'sports']);
  });

  it('returns the everyday, sports and dojo lists as defined', () => {
    for (const pack of ['everyday', 'sports', 'dojo'] as const) {
      for (const tier of ALL_TIERS) expect(packWords(pack, tier)).toEqual(PACKS[pack][tier]);
    }
  });

  it('mixed is the deduplicated union of the three packs', () => {
    for (const tier of ALL_TIERS) {
      const mixed = packWords('mixed', tier);
      expect(duplicatesOf(mixed)).toEqual([]);
      expect(new Set(mixed)).toEqual(new Set([...PACKS.everyday[tier], ...PACKS.sports[tier], ...PACKS.dojo[tier]]));
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
  for (const pack of PACK_IDS) {
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
    const words = wordsOf(pickTriple(seedRng(3), picker, 'sports'));
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
    const allowedEasy = PACKS.dojo.easy.slice(0, 2);
    const avoid = PACKS.dojo.easy.slice(2);
    const rng = seedRng(99);
    const picker = createPicker();
    let repeats = 0;
    for (let i = 0; i < 50; i++) {
      const recent = [...picker.history];
      const words = wordsOf(pickTriple(rng, picker, 'dojo', avoid));
      expect(allowedEasy, `pick ${i}`).toContain(words[0]);
      expect(initialsClash(words), `pick ${i}: ${words.join(' ')}`).toBe(false);
      if (words.some((w) => recent.includes(w))) repeats++;
      expect(picker.history.length).toBeLessThanOrEqual(HISTORY);
    }
    expect(repeats).toBeGreaterThan(0);
  });

  it('throws when no triple can satisfy the avoid and initials rules', () => {
    expect(() => pickTriple(seedRng(1), createPicker(), 'sports', PACKS.sports.easy)).toThrow(/pickTriple/);
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
    run(rng, picker, 'dojo', 50);
    const rngCopy = JSON.parse(JSON.stringify(rng)) as RngState;
    const pickerCopy = JSON.parse(JSON.stringify(picker)) as PickerState;
    expect(run(rngCopy, pickerCopy, 'dojo', 100)).toEqual(run(rng, picker, 'dojo', 100));
  });

  it('gives different sequences for different seeds', () => {
    expect(run(seedRng(1), createPicker(), 'everyday', 20)).not.toEqual(run(seedRng(2), createPicker(), 'everyday', 20));
  });
});

describe('pickFixed', () => {
  const list = [
    ['ball', 'topspin', 'tiebreaker'],
    ['net', 'backhand', 'tournament'],
  ];

  it('returns the next triple as options', () => {
    expect(pickFixed(createPicker(), list, 'serve')).toEqual([
      { word: 'ball', len: 4, tier: 'easy' },
      { word: 'topspin', len: 7, tier: 'medium' },
      { word: 'tiebreaker', len: 10, tier: 'hard' },
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
    expect(toOption('ox')).toEqual({ word: 'ox', len: 2, tier: 'easy' });
    expect(toOption('topspin')).toEqual({ word: 'topspin', len: 7, tier: 'medium' });
    expect(toOption('tiebreaker')).toEqual({ word: 'tiebreaker', len: 10, tier: 'hard' });
    expect(toOption('serveandvolley')).toEqual({ word: 'serveandvolley', len: 14, tier: 'insane' });
  });

  it('throws on anything but a 2–15-letter lowercase a–z word', () => {
    for (const bad of ['Ball', '', 'a', 'abcdefghijklmnop', 'ball!', 'ba ll', 'café']) {
      expect(() => toOption(bad), bad).toThrow();
    }
  });
});
