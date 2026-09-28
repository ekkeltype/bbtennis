import { describe, expect, it } from 'vitest';
import { aggressionAt, CPU_LEVELS, CpuBrain, cpuProfile, isMilestone, nominalWpmFor, typistProfile } from '../../src/core/cpu';
import type { CpuPolicy, CpuProfile, PlannedKey } from '../../src/core/cpu';
import { forkSeed, seedRng, uniform } from '../../src/core/rng';
import { CPU_LEVEL_WPM, CPU_MILESTONES, CPU_NOMINAL_WPM, TUNING } from '../../src/core/tuning';
import { createTurn, startTurn, turnInput } from '../../src/core/turn';
import { applyLetter, createPrompt, lockedWord } from '../../src/core/typing';
import type { KeyResult } from '../../src/core/typing';
import { other } from '../../src/core/types';
import type {
  BallFlight,
  PlayerId,
  PromptState,
  ReturnTurnData,
  ServeTurnData,
  ShotRandoms,
  Tier,
  TurnData,
  TurnPhase,
  TurnState,
  WordOption,
} from '../../src/core/types';
import { packWords } from '../../src/core/words/lists';
import { createPicker, pickSet, toOption } from '../../src/core/words/picker';
import { CHOICE_4, INSANE_WORD, returnData, serveData, serveSet, SET_A } from './turnFixtures';

const MILESTONE_LEVELS = [0, 3, 6, 9, 12, 13, 14];

// ---------------------------------------------------------------------------------------------
// Hand-built TurnState fixtures (turn.ts is built in parallel and is not imported here).

const RANDOMS: ShotRandoms = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
const SERVE_WORDS = ['lob', 'fencing', 'tournament'];
const SPARE_SERVE_WORDS = ['ace', 'volley', 'basketball'];
const CHOICE_WORDS = ['drop', 'topspin', 'interesting'];
/** A mid-table typist used where the exact profile does not matter. */
const PROFILE: CpuProfile = { wpm: 60, nominalWpm: 60, err: 0.03, wordPauseMs: 600, serveChasePauseMs: 500, earlyPauseMs: 300, aggression: 0.5 };
/** No typing errors, so choice estimates are exact: est(len) = 500 + 200·len ms. */
const CLEAN: CpuProfile = { wpm: 60, nominalWpm: 60, err: 0, wordPauseMs: 500, serveChasePauseMs: 500, earlyPauseMs: 500, aggression: 1 };

function newTurn(data: TurnData, phase: TurnPhase, τ: number): TurnState {
  return {
    data,
    started: true,
    τ,
    phase,
    prompts: [],
    active: null,
    tossAt: null,
    catchAt: null,
    setIndex: 0,
    frozenMs: 0,
    freezeSince: null,
    seenKinds: [],
    log: [],
    outcome: null,
    ended: false,
  };
}

interface ServeOpts { turnId?: number; owner?: PlayerId; serveNo?: 1 | 2; tossApexMs?: number; pace?: number; leadInMs?: number }

/** A serve turn in PRE_SERVE at τ = leadIn.ms, word sets [SERVE_WORDS, SPARE_SERVE_WORDS]. */
function serveTurn(o: ServeOpts = {}): TurnState {
  const owner = o.owner ?? 0;
  const turnId = o.turnId ?? 1;
  const leadInMs = o.leadInMs ?? 2500;
  const data: ServeTurnData = {
    kind: 'serve',
    turnId,
    promptBase: turnId * 8,
    owner,
    receiver: other(owner),
    serveNo: o.serveNo ?? 1,
    side: 'deuce',
    leadIn: { kind: 'point', ms: leadInMs, text: ['ACE!'] },
    serveClockMs: 30000,
    tossApexMs: o.tossApexMs ?? 2000,
    catchMs: 500,
    pace: o.pace ?? 1,
    wordSets: [SERVE_WORDS, SPARE_SERVE_WORDS].map((words) => ({
      options: words.map(toOption),
      targets: words.map(() => ({ x: 0, y: 0 })),
      variant: 'T' as const,
    })),
    randoms: RANDOMS,
    freezeFirst: false,
    power: 0,
  };
  return newTurn(data, 'preServe', leadInMs);
}

interface ReturnOpts { turnId?: number; owner?: PlayerId; chase?: string; choice?: string[]; T?: number; isServeReturn?: boolean; earlyFrom?: number | null }

/** A started return turn: chase prompt (id promptBase) shown and locked at earlyFrom (0 by default for a rally, and for a serve return). */
function returnTurn(o: ReturnOpts = {}): TurnState {
  const owner = o.owner ?? 0;
  const turnId = o.turnId ?? 1;
  const T = o.T ?? 4000;
  const isServeReturn = o.isServeReturn ?? false;
  const chase = toOption(o.chase ?? 'rally');
  const incoming: BallFlight = {
    isServe: isServeReturn,
    tier: chase.tier,
    p0: { x: 0, y: 12, z: 1 },
    landing: { x: 0, y: -8 },
    outcome: 'in',
    T,
    tBounce: 0.6 * T,
    grace: 400,
    h: 2,
    contact: { x: 0, y: -11 },
    netT: 0.3 * T,
    callT: null,
    destEnd: owner,
  };
  const data: ReturnTurnData = {
    kind: 'return',
    turnId,
    promptBase: turnId * 8,
    owner,
    striker: other(owner),
    incoming,
    chase,
    isServeReturn,
    earlyFrom: o.earlyFrom === undefined ? (isServeReturn ? null : 0) : o.earlyFrom,
    n: 0,
    choice: { options: (o.choice ?? CHOICE_WORDS).map(toOption), targets: [0, 1, 2].map(() => ({ x: 0, y: 0 })), m: 1 },
    pace: 1,
    randoms: RANDOMS,
    freezeFirst: false,
    power: 0,
  };
  const t = newTurn(data, 'chase', 0);
  const shownAt = data.earlyFrom ?? 0;
  t.prompts.push(createPrompt(data.promptBase, 'chase', [chase], shownAt));
  t.active = 0;
  t.log.push({ τ: shownAt, k: 'show', prompt: data.promptBase });
  return t;
}

interface FedKey extends PlannedKey { prompt: number | null; result: KeyResult | 'toss' }

/**
 * Applies one planned input the way the TurnRunner does, minus deadlines: 'toss' shows the serve
 * prompt; letters go to the active prompt; a completed chase shows the choice prompt (id promptBase + 1).
 */
function feed(t: TurnState, k: PlannedKey): FedKey {
  if (k.τ < t.τ) throw new Error(`planned input at ${k.τ} is before the turn clock ${t.τ}`);
  t.τ = k.τ;
  const d = t.data;
  if (k.key === 'toss') {
    const set = d.kind === 'serve' ? d.wordSets[t.setIndex] : undefined;
    if (set === undefined || t.phase !== 'preServe') throw new Error(`toss in phase ${t.phase}`);
    const prompt = createPrompt(d.promptBase + t.prompts.length, 'serve', set.options, k.τ);
    t.prompts.push(prompt);
    t.active = t.prompts.length - 1;
    t.phase = 'toss';
    t.tossAt = k.τ;
    t.log.push({ τ: k.τ, k: 'toss' }, { τ: k.τ, k: 'show', prompt: prompt.id });
    return { ...k, prompt: null, result: 'toss' };
  }
  const p = t.active === null ? undefined : t.prompts[t.active];
  if (p === undefined) throw new Error(`letter '${k.key}' with no active prompt`);
  const result = applyLetter(p, k.key, k.τ);
  if (result === 'ignored') throw new Error(`letter '${k.key}' ignored by prompt ${p.id}`);
  if (result === 'completed' && p.kind === 'chase' && d.kind === 'return') {
    t.prompts.push(createPrompt(d.promptBase + 1, 'choice', d.choice.options, k.τ));
    t.active = t.prompts.length - 1;
    t.phase = 'choice';
  }
  return { ...k, prompt: p.id, result };
}

/** Feeds the brain's next planned input until it plans nothing more; returns everything fed. */
function drive(brain: CpuBrain, t: TurnState): FedKey[] {
  const fed: FedKey[] = [];
  for (let next = brain.plan(t)[0]; next !== undefined; next = brain.plan(t)[0]) {
    fed.push(feed(t, next));
    if (fed.length > 1000) throw new Error('drive: the plan never ends');
  }
  return fed;
}

/** Tier of the option that a plan's first key locks (options have distinct initials). */
function lockedTier(options: readonly WordOption[], plan: readonly PlannedKey[]): Tier | undefined {
  return options.find((o) => o.word[0] === plan[0]?.key)?.tier;
}

/** Tosses a serve turn and returns the tier of the word the brain then plans to type. */
function serveTier(brain: CpuBrain, t: TurnState): Tier | undefined {
  const toss = brain.plan(t)[0];
  if (toss === undefined) throw new Error('no toss planned');
  feed(t, toss);
  return lockedTier(t.prompts[0]?.options ?? [], brain.plan(t));
}

/** Types a return turn's chase, then returns the tier of the choice option the brain plans to lock. */
function choiceTier(brain: CpuBrain, t: TurnState): Tier | undefined {
  while (t.phase === 'chase') {
    const next = brain.plan(t)[0];
    if (next === undefined) throw new Error('chase not planned to completion');
    feed(t, next);
  }
  return lockedTier(t.prompts[1]?.options ?? [], brain.plan(t));
}

interface Typed { word: WordOption; prompt: PromptState; keys: FedKey[] }

/** Plays one return turn per chase word (rally chases, huge T) and returns every word typed, chase and choice. */
function typeWords(profile: CpuProfile, seed: number, chaseWords: readonly string[], policy?: CpuPolicy): Typed[] {
  const brain = new CpuBrain(0, profile, seed, { policy });
  const rng = seedRng(seed);
  const picker = createPicker();
  const typed: Typed[] = [];
  chaseWords.forEach((chase, i) => {
    const choice = pickSet(rng, picker, 'mixed').map((o) => o.word);
    const t = returnTurn({ turnId: i + 1, chase, choice, T: 1e7 });
    const fed = drive(brain, t);
    for (const prompt of t.prompts) {
      const word = lockedWord(prompt);
      if (word === null || prompt.completedAt === null) throw new Error(`prompt ${prompt.id} was not completed`);
      typed.push({ word, prompt, keys: fed.filter((k) => k.prompt === prompt.id) });
    }
  });
  return typed;
}

/** `count` words cycling through the given tiers of the mixed pack (stride 7, so even a short run mixes the tiers). */
function wordsOf(tiers: readonly Tier[], count: number): string[] {
  const pool = tiers.flatMap((tier) => packWords('mixed', tier));
  return Array.from({ length: count }, (_, i) => pool[(i * 7) % pool.length] as string);
}

/** Average WPM as the spec defines it (§3.11): 12·Σ(n − 1)/ΣΔt over completed words. */
function averageWpm(words: readonly Typed[]): number {
  const intervals = words.reduce((s, w) => s + w.word.len - 1, 0);
  const ms = words.reduce((s, w) => s + ((w.prompt.tLast ?? 0) - (w.prompt.tFirst ?? 0)), 0);
  return (12000 * intervals) / ms;
}

/** Gaps between consecutive correct keys of a word. */
function correctGaps(w: Typed): number[] {
  const correct = w.keys.filter((k) => k.result !== 'wrong');
  return correct.slice(1).map((k, i) => k.τ - (correct[i]?.τ ?? Number.NaN));
}

describe('CPU_LEVELS', () => {
  it('has 15 levels, indexed by level, with the WPMs of CPU_LEVEL_WPM', () => {
    expect(CPU_LEVELS.length).toBe(15);
    expect(CPU_LEVELS.map((l) => l.level)).toEqual([...Array(15).keys()]);
    expect(CPU_LEVELS.map((l) => l.wpm)).toEqual([...CPU_LEVEL_WPM]);
    expect([...CPU_LEVEL_WPM]).toEqual([25, 28, 32, 36, 41, 46, 52, 59, 67, 76, 86, 97, 110, 124, 140]);
  });

  it('climbs white → brown with 0–2 stripes, then black and the 2nd and 3rd dan', () => {
    expect(CPU_LEVELS.map((l) => [l.belt, l.stripes, l.dan])).toEqual([
      ['white', 0, 0], ['white', 1, 0], ['white', 2, 0],
      ['yellow', 0, 0], ['yellow', 1, 0], ['yellow', 2, 0],
      ['green', 0, 0], ['green', 1, 0], ['green', 2, 0],
      ['brown', 0, 0], ['brown', 1, 0], ['brown', 2, 0],
      ['black', 0, 0], ['black', 0, 2], ['black', 0, 3],
    ]);
  });

  it('labels each level with its belt and stripes (★) or dan grade', () => {
    expect(CPU_LEVELS.map((l) => l.label)).toEqual([
      'WHITE BELT', 'WHITE BELT ★', 'WHITE BELT ★★',
      'YELLOW BELT', 'YELLOW BELT ★', 'YELLOW BELT ★★',
      'GREEN BELT', 'GREEN BELT ★', 'GREEN BELT ★★',
      'BROWN BELT', 'BROWN BELT ★', 'BROWN BELT ★★',
      'BLACK BELT', 'BLACK BELT 2ND DAN', 'BLACK BELT 3RD DAN',
    ]);
  });
});

describe('isMilestone', () => {
  it('is true exactly at levels 0, 3, 6, 9, 12, 13 and 14', () => {
    const milestones = CPU_LEVELS.filter((l) => isMilestone(l.level)).map((l) => l.level);
    expect(milestones).toEqual(MILESTONE_LEVELS);
  });

  it('is false for levels that do not exist', () => {
    for (const level of [-1, 15, 1.5, Number.NaN]) expect(isMilestone(level)).toBe(false);
  });
});

describe('typistProfile (early-typing spec §5)', () => {
  it('uses the model end points at 25 and 140 WPM', () => {
    expect(typistProfile(25, 0.2, 27)).toEqual({ wpm: 25, nominalWpm: 27, err: 0.07, wordPauseMs: 950, serveChasePauseMs: 600, earlyPauseMs: 500, aggression: 0.2 });
    const top = typistProfile(140, 0.9, 198);
    expect(top.err).toBeCloseTo(0.04, 12);
    expect([top.wordPauseMs, top.serveChasePauseMs, top.earlyPauseMs]).toEqual([600, 400, 300]);
  });

  it('interpolates linearly in WPM between 25 and 140 (98 WPM: about 5 % errors and a 0.73 s word pause)', () => {
    const p = typistProfile(98, 0.5, 120);
    const f = (98 - 25) / 115;
    expect(p.err).toBeCloseTo(0.07 - 0.03 * f, 12);
    expect(p.wordPauseMs).toBeCloseTo(950 - 350 * f, 9);
    expect(p.serveChasePauseMs).toBeCloseTo(600 - 200 * f, 9);
    expect(p.earlyPauseMs).toBeCloseTo(500 - 200 * f, 9);
    expect(p.err).toBeCloseTo(0.051, 3);
    expect(p.wordPauseMs).toBeCloseTo(728, 0);
  });

  it('holds the rates and pauses outside 25–140 WPM but keeps the speeds', () => {
    expect(typistProfile(15, 0.2, 16)).toMatchObject({ wpm: 15, nominalWpm: 16, err: 0.07, wordPauseMs: 950 });
    expect(typistProfile(170, 0.9, 240)).toMatchObject({ wpm: 170, nominalWpm: 240, wordPauseMs: 600, earlyPauseMs: 300 });
  });

  it('defaults the nominal speed to the calibrated table', () => {
    expect(typistProfile(CPU_LEVEL_WPM[6], 0.5).nominalWpm).toBe(CPU_NOMINAL_WPM[6]);
  });

  it('rejects a speed that is not finite and positive', () => {
    for (const wpm of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => typistProfile(wpm, 0.5)).toThrow(RangeError);
  });
});

describe('nominalWpmFor', () => {
  it('is the table at each level, linear between levels, and the end ratio beyond the ladder', () => {
    CPU_LEVEL_WPM.forEach((wpm, level) => expect(nominalWpmFor(wpm)).toBe(CPU_NOMINAL_WPM[level]));
    const mid = (CPU_LEVEL_WPM[6] + CPU_LEVEL_WPM[7]) / 2;
    expect(nominalWpmFor(mid)).toBeCloseTo((CPU_NOMINAL_WPM[6] + CPU_NOMINAL_WPM[7]) / 2, 9);
    expect(nominalWpmFor(12.5)).toBeCloseTo((12.5 * CPU_NOMINAL_WPM[0]) / 25, 9);
    expect(nominalWpmFor(280)).toBeCloseTo((280 * CPU_NOMINAL_WPM[14]) / 140, 9);
  });

  it('always types faster underneath than the label', () => {
    CPU_LEVEL_WPM.forEach((wpm, level) => expect(CPU_NOMINAL_WPM[level]).toBeGreaterThan(wpm));
  });
});

describe('aggressionAt', () => {
  it("is each milestone row's value at its WPM, linear between rows, held beyond them", () => {
    for (const row of CPU_MILESTONES) expect(aggressionAt(row.wpm)).toBeCloseTo(row.aggression, 12);
    expect(aggressionAt(30.5)).toBeCloseTo(0.2 + 0.15 * (5.5 / 11), 12);
    expect(aggressionAt(10)).toBe(0.2);
    expect(aggressionAt(200)).toBe(0.9);
  });
});

describe('cpuProfile', () => {
  it("is the typist model at the level's WPM, with its calibrated nominal speed and its belt aggression", () => {
    CPU_LEVELS.forEach(({ level, wpm }) => {
      expect(cpuProfile(level)).toEqual(typistProfile(wpm, aggressionAt(wpm), CPU_NOMINAL_WPM[level]));
    });
  });

  it('uses the milestone aggression exactly at milestone levels', () => {
    expect(MILESTONE_LEVELS.map((level) => cpuProfile(level).aggression)).toEqual(CPU_MILESTONES.map((m) => m.aggression));
  });

  it('gets strictly faster, more accurate, quicker and more aggressive with every level', () => {
    const profiles = CPU_LEVELS.map((l) => cpuProfile(l.level));
    for (let i = 1; i < profiles.length; i++) {
      const [prev, cur] = [profiles[i - 1]!, profiles[i]!];
      expect(cur.wpm).toBeGreaterThan(prev.wpm);
      expect(cur.nominalWpm).toBeGreaterThan(prev.nominalWpm);
      expect(cur.err).toBeLessThan(prev.err);
      expect(cur.wordPauseMs).toBeLessThan(prev.wordPauseMs);
      expect(cur.earlyPauseMs).toBeLessThan(prev.earlyPauseMs);
      expect(cur.aggression).toBeGreaterThan(prev.aggression);
    }
  });

  it('rejects levels that do not exist', () => {
    for (const level of [-1, 15, 1.5, Number.NaN]) expect(() => cpuProfile(level)).toThrow(RangeError);
  });
});

describe('CpuBrain — serve turns', () => {
  it('tosses 600–1200 ms after PRE_SERVE starts', () => {
    const tosses = Array.from({ length: 300 }, (_, seed) => new CpuBrain(0, PROFILE, seed).plan(serveTurn()));
    for (const plan of tosses) {
      expect(plan).toHaveLength(1);
      expect(plan[0]?.key).toBe('toss');
    }
    const delays = tosses.map((plan) => (plan[0]?.τ ?? Number.NaN) - 2500);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(600);
    expect(Math.max(...delays)).toBeLessThan(1200);
    expect(Math.min(...delays)).toBeLessThan(700);
    expect(Math.max(...delays)).toBeGreaterThan(1100);
  });

  it('keeps the planned toss moment across calls, however late in PRE_SERVE it first looks', () => {
    const early = new CpuBrain(0, PROFILE, 7);
    const late = new CpuBrain(0, PROFILE, 7);
    const t = serveTurn();
    const planned = early.plan(t);
    t.τ = 3000;
    expect(early.plan(t)).toEqual(planned);
    expect(late.plan(t)).toEqual(planned);
  });

  it('tosses at once when the turn clock is already past the planned moment', () => {
    const t = serveTurn();
    t.τ = 9000;
    expect(new CpuBrain(0, PROFILE, 7).plan(t)).toEqual([{ key: 'toss', τ: 9000 }]);
  });

  it('counts the toss delay after a catch from the end of the catch', () => {
    for (let seed = 0; seed < 100; seed++) {
      const t = serveTurn();
      t.setIndex = 1;
      t.log.push({ τ: 3000, k: 'toss' }, { τ: 7000, k: 'catch' });
      t.τ = 7500;
      const τ = new CpuBrain(0, PROFILE, seed).plan(t)[0]?.τ ?? Number.NaN;
      expect(τ).toBeGreaterThanOrEqual(7500 + 600);
      expect(τ).toBeLessThan(7500 + 1200);
    }
  });

  it('never plans a toss outside PRE_SERVE, nor when no serve word set is left', () => {
    const brain = new CpuBrain(0, PROFILE, 1);
    for (const phase of ['leadIn', 'catch', 'ended'] as const) {
      const t = serveTurn();
      t.phase = phase;
      expect(brain.plan(t)).toEqual([]);
    }
    const t = serveTurn();
    t.setIndex = 2;
    expect(brain.plan(t)).toEqual([]);
    const tossed = serveTurn();
    feed(tossed, brain.plan(tossed)[0] as PlannedKey);
    expect(brain.plan(tossed).some((k) => k.key === 'toss')).toBe(false);
  });

  it('types the serve word a word pause after the toss, then plans nothing more', () => {
    const brain = new CpuBrain(0, PROFILE, 3);
    const t = serveTurn();
    const fed = drive(brain, t);
    const [toss, first] = fed;
    expect(toss?.key).toBe('toss');
    expect(first?.τ).toBe((toss?.τ ?? 0) + PROFILE.wordPauseMs);
    const prompt = t.prompts[0];
    expect(prompt?.completedAt).not.toBeNull();
    const letters = fed.filter((k) => k.result !== 'wrong' && k.result !== 'toss').map((k) => k.key);
    expect(letters.join('')).toBe(prompt === undefined ? undefined : lockedWord(prompt)?.word);
    expect(t.phase).toBe('toss');
    expect(brain.plan(t)).toEqual([]);
  });

  it('picks easy when no serve word fits before the ball drops, and hard with a huge deadline and aggression 1', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(serveTier(new CpuBrain(0, CLEAN, seed), serveTurn({ tossApexMs: 100 }))).toBe('easy');
      expect(serveTier(new CpuBrain(0, CLEAN, seed), serveTurn({ tossApexMs: 1e6 }))).toBe('hard');
    }
  });

  it('judges fit against tossAt + 2·tossApexMs·pace minus 250 ms', () => {
    // est: easy (3) 1100, medium (7) 1900, hard (10) 2500 ms; probed 1 ms either side.
    const tier = (tossApexMs: number, pace: number): Tier | undefined =>
      serveTier(new CpuBrain(0, CLEAN, 5), serveTurn({ tossApexMs, pace }));
    expect(tier(1075.5, 1)).toBe('medium'); // 2151 − 250 = 1901 ≥ 1900
    expect(tier(1074.5, 1)).toBe('easy');
    expect(tier(1375.5, 1)).toBe('hard'); // 2751 − 250 = 2501 ≥ 2500
    expect(tier(1374.5, 1)).toBe('medium');
    expect(tier(2751, 0.5)).toBe('hard'); // pace scales the apex
    expect(tier(2749, 0.5)).toBe('medium');
  });

  it('judges a serve word it first sees late against the time left from then (deadline − now)', () => {
    // est: medium (7) 1900 ms; deadline tossAt + 2600 ⇒ medium fits when first seen ≤ 450 ms after the toss.
    const tier = (lateMs: number): Tier | undefined => {
      const brain = new CpuBrain(0, CLEAN, 5);
      const t = serveTurn({ tossApexMs: 1300 });
      feed(t, brain.plan(t)[0] as PlannedKey);
      t.τ = (t.tossAt ?? Number.NaN) + lateMs;
      return lockedTier(t.prompts[0]?.options ?? [], brain.plan(t));
    };
    expect(tier(0)).toBe('medium');
    expect(tier(449)).toBe('medium'); // 2600 − 449 − 250 = 1901 ≥ 1900
    expect(tier(451)).toBe('easy');
  });

  it('counts expected error time in the estimate', () => {
    // err 0.1: est(medium 7) = 500 + 7·200·(1 + 0.1/0.9) + 0.1·7·300 ≈ 2266 ms > 2400 − 250.
    const sloppy: CpuProfile = { ...CLEAN, err: 0.1 };
    expect(serveTier(new CpuBrain(0, CLEAN, 5), serveTurn({ tossApexMs: 1200 }))).toBe('medium');
    expect(serveTier(new CpuBrain(0, sloppy, 5), serveTurn({ tossApexMs: 1200 }))).toBe('easy');
  });

  it('takes the hardest fitting word with probability = aggression, otherwise one of the other fitting words uniformly', () => {
    const count = (aggression: number, tossApexMs: number): Record<string, number> => {
      const brain = new CpuBrain(0, { ...CLEAN, aggression }, 11);
      const counts: Record<string, number> = {};
      for (let i = 1; i <= 2000; i++) {
        const tier = serveTier(brain, serveTurn({ turnId: i, tossApexMs })) ?? 'none';
        counts[tier] = (counts[tier] ?? 0) + 1;
      }
      return counts;
    };
    // Easy and medium fit: aggression 0 always takes the other one, easy.
    expect(count(0, 1200)).toEqual({ easy: 2000 });
    // All three fit: aggression 0.5 ⇒ hard 50 %, easy and medium 25 % each.
    const all = count(0.5, 2000);
    expect((all.hard ?? 0) / 2000).toBeCloseTo(0.5, 1);
    expect((all.medium ?? 0) / 2000).toBeCloseTo(0.25, 1);
    expect((all.easy ?? 0) / 2000).toBeCloseTo(0.25, 1);
  });

  it('is less aggressive on the second serve (aggression × 0.4) over 2,000 serves', () => {
    const pHard = (serveNo: 1 | 2): number => {
      const brain = new CpuBrain(0, { ...PROFILE, aggression: 0.8 }, 99);
      let hard = 0;
      for (let i = 1; i <= 2000; i++) if (serveTier(brain, serveTurn({ turnId: i, serveNo })) === 'hard') hard++;
      return hard / 2000;
    };
    const first = pHard(1);
    const second = pHard(2);
    expect(second).toBeLessThan(first);
    expect(first).toBeGreaterThan(0.76);
    expect(first).toBeLessThan(0.84);
    expect(second).toBeGreaterThan(0.28);
    expect(second).toBeLessThan(0.36);
  });
});

describe('CpuBrain — return turns', () => {
  it('starts a rally chase earlyPauseMs after it is shown and a serve-return chase serveChasePauseMs after', () => {
    expect(new CpuBrain(0, PROFILE, 1).plan(returnTurn())[0]?.τ).toBe(PROFILE.earlyPauseMs);
    expect(new CpuBrain(0, PROFILE, 1).plan(returnTurn({ isServeReturn: true }))[0]?.τ).toBe(PROFILE.serveChasePauseMs);
  });

  it('plans the choice with the chase: its first key comes a word pause after the chase completes', () => {
    const brain = new CpuBrain(0, PROFILE, 4);
    const t = returnTurn();
    const planned = brain.plan(t);
    const fed = drive(brain, t);
    expect(fed.map(({ key, τ }) => ({ key, τ }))).toEqual(planned);
    const [chase, choice] = t.prompts;
    expect(chase?.completedAt).not.toBeNull();
    expect(choice?.completedAt).not.toBeNull();
    expect(choice?.tFirst).toBe((chase?.completedAt ?? 0) + PROFILE.wordPauseMs);
    expect(t.phase).toBe('choice');
    expect(brain.plan(t)).toEqual([]);
  });

  it('picks easy when nothing fits before T, and hard with a huge T and aggression 1', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(choiceTier(new CpuBrain(0, CLEAN, seed), returnTurn({ T: 100 }))).toBe('easy');
      expect(choiceTier(new CpuBrain(0, CLEAN, seed), returnTurn({ T: 1e6 }))).toBe('hard');
    }
  });

  it('judges the choice against T from the moment the choice is shown', () => {
    // est: easy 'drop' 1300, medium 'topspin' 1900, hard 'interesting' 2700 ms; probed 1 ms either side.
    for (let seed = 0; seed < 20; seed++) {
      const probe = returnTurn();
      drive(new CpuBrain(0, CLEAN, seed), probe);
      const shownAt = probe.prompts[1]?.shownAt ?? Number.NaN;
      const tier = (T: number): Tier | undefined => choiceTier(new CpuBrain(0, CLEAN, seed), returnTurn({ T }));
      expect(tier(shownAt + 250 + 1901)).toBe('medium');
      expect(tier(shownAt + 250 + 1899)).toBe('easy');
      expect(tier(shownAt + 250 + 2701)).toBe('hard');
      expect(tier(shownAt + 250 + 2699)).toBe('medium');
    }
  });

  it('judges a choice it first sees late against the time left from then (T − now)', () => {
    // est: medium 'topspin' 1900 ms; T = shownAt + 2400 ⇒ medium fits when first seen ≤ 250 ms after it is shown.
    const tier = (lateMs: number): Tier | undefined => {
      const t = returnTurn({ T: 2900 });
      [...'rally'].forEach((key, i) => feed(t, { key, τ: 100 * (i + 1) })); // the choice is shown at 500
      t.τ = 500 + lateMs;
      return lockedTier(t.prompts[1]?.options ?? [], new CpuBrain(0, CLEAN, 5).plan(t));
    };
    expect(tier(0)).toBe('medium');
    expect(tier(249)).toBe('medium'); // 2400 − 249 − 250 = 1901 ≥ 1900
    expect(tier(251)).toBe('easy');
  });
});

describe('CpuBrain — skipped keys', () => {
  const SLOPPY: CpuProfile = { ...PROFILE, err: 0.2 };

  it('re-plans a serve word from its actual state at the turn clock when a planned key is skipped', () => {
    const skipped = { right: 0, wrong: 0 };
    for (const skip of [0, 1, 2]) {
      for (let seed = 0; seed < 30; seed++) {
        const brain = new CpuBrain(0, SLOPPY, seed);
        const t = serveTurn();
        feed(t, brain.plan(t)[0] as PlannedKey);
        const planned = brain.plan(t);
        const prompt = t.prompts[0] as PromptState;
        const word = prompt.options.find((o) => o.word[0] === planned[0]?.key);
        planned.slice(0, skip).forEach((k) => feed(t, k));
        const missed = planned[skip] as PlannedKey;
        skipped[missed.key === word?.word[prompt.typed] ? 'right' : 'wrong']++;
        t.τ = missed.τ + 1; // clocked past it, never fed
        const replanned = brain.plan(t);
        expect(replanned[0]?.τ).toBe(t.τ);
        expect(brain.plan(t)).toEqual(replanned);
        drive(brain, t);
        expect(prompt.completedAt).not.toBeNull();
        expect(lockedWord(prompt)).toEqual(word);
      }
    }
    expect(skipped.wrong).toBeGreaterThan(0);
    expect(skipped.right).toBeGreaterThan(0);
  });

  it('completes a chase with a skipped key, then starts the choice a word pause after the chase really completes', () => {
    for (let seed = 0; seed < 20; seed++) {
      const brain = new CpuBrain(0, SLOPPY, seed);
      const t = returnTurn();
      const planned = brain.plan(t);
      planned.slice(0, 2).forEach((k) => feed(t, k));
      t.τ = (planned[2]?.τ ?? Number.NaN) + 1;
      expect(brain.plan(t)[0]?.τ).toBe(t.τ);
      drive(brain, t);
      const [chase, choice] = t.prompts;
      expect(chase?.completedAt).not.toBeNull();
      expect(choice?.completedAt).not.toBeNull();
      expect(choice?.tFirst).toBe((chase?.completedAt ?? Number.NaN) + SLOPPY.wordPauseMs);
    }
  });
});

describe('CpuBrain — turn ids', () => {
  it('plans correctly when reused for a second match whose turn and prompt ids restart at 1', () => {
    const brain = new CpuBrain(0, PROFILE, 3);
    drive(brain, returnTurn({ turnId: 1, chase: 'rally' }));
    drive(brain, serveTurn({ turnId: 2 }));

    const ret = returnTurn({ turnId: 1, chase: 'bench' });
    const fed = drive(brain, ret);
    expect(fed[0]).toMatchObject({ key: 'b', τ: PROFILE.earlyPauseMs });
    expect(ret.prompts.map((p) => p.completedAt !== null)).toEqual([true, true]);

    const serve = serveTurn({ turnId: 2, leadInMs: 4000 });
    const toss = brain.plan(serve)[0]?.τ ?? Number.NaN;
    expect(toss).toBeGreaterThanOrEqual(4000 + 600);
    expect(toss).toBeLessThan(4000 + 1200);
    drive(brain, serve);
    expect(serve.prompts[0]?.completedAt).not.toBeNull();
  });
});

describe('CpuBrain — policies', () => {
  const serve = (policy: CpuPolicy | undefined, tossApexMs: number): Tier | undefined =>
    serveTier(new CpuBrain(0, CLEAN, 2, policy === undefined ? undefined : { policy }), serveTurn({ tossApexMs }));
  const choice = (policy: CpuPolicy, T: number): Tier | undefined =>
    choiceTier(new CpuBrain(0, CLEAN, 2, { policy }), returnTurn({ T }));

  it("'alwaysEasy' always picks easy, even when hard fits", () => {
    expect(serve('alwaysEasy', 1e6)).toBe('easy');
    expect(choice('alwaysEasy', 1e6)).toBe('easy');
  });

  it("'alwaysHard' always picks hard, even when it cannot fit", () => {
    expect(serve('alwaysHard', 100)).toBe('hard');
    expect(choice('alwaysHard', 100)).toBe('hard');
  });

  it("'neverHard' applies the adaptive rule to easy and medium only", () => {
    expect(serve('neverHard', 1e6)).toBe('medium');
    expect(choice('neverHard', 1e6)).toBe('medium');
    expect(serve('neverHard', 1200)).toBe('medium');
    expect(serve('neverHard', 100)).toBe('easy');
  });

  it("defaults to 'adaptive'", () => {
    for (const apex of [100, 1200, 1e6]) expect(serve(undefined, apex)).toBe(serve('adaptive', apex));
    expect(serve('adaptive', 1e6)).toBe('hard');
  });
});

describe('CpuBrain — key timing', () => {
  const EASY_MEDIUM = wordsOf(['easy', 'medium'], 1000);

  it.each([0, 6, 9, 12, 14])("types 1,000 easy/medium words within ±10 %% of level %i's nominal speed slowed by its error pauses", (level) => {
    const profile = cpuProfile(level);
    const { min, max } = TUNING.typist.wrongPauseRangeMs;
    const expected = 12000 / (12000 / profile.nominalWpm + profile.err * ((min + max) / 2));
    const words = typeWords(profile, 100 + level, EASY_MEDIUM).filter((w) => w.word.tier !== 'hard');
    expect(words.length).toBeGreaterThanOrEqual(1000);
    expect(words.some((w) => w.prompt.wrongKeys > 0)).toBe(true);
    expect(averageWpm(words) / expected).toBeGreaterThan(0.9);
    expect(averageWpm(words) / expected).toBeLessThan(1.1);
  });

  it.each([0, 6, 12])('never errs on a first key; level %i wrong-key rate is within ±25 %% of err', (level) => {
    const profile = cpuProfile(level);
    const words = typeWords(profile, 200 + level, wordsOf(['easy', 'medium', 'hard'], 1000));
    for (const w of words) expect(w.keys[0]?.result).not.toBe('wrong');
    const wrong = words.reduce((s, w) => s + w.prompt.wrongKeys, 0);
    const slots = words.reduce((s, w) => s + w.word.len - 1, 0);
    expect(wrong / slots / profile.err).toBeGreaterThan(0.75);
    expect(wrong / slots / profile.err).toBeLessThan(1.25);
  });

  it('follows each wrong key with the right letter 200–400 ms later', () => {
    const words = typeWords({ ...PROFILE, err: 0.3 }, 5, wordsOf(['easy', 'medium', 'hard'], 200));
    let errors = 0;
    for (const w of words) {
      w.keys.forEach((k, i) => {
        if (k.result !== 'wrong') return;
        errors++;
        const next = w.keys[i + 1];
        const expected = w.word.word[w.keys.slice(0, i).filter((x) => x.result !== 'wrong').length];
        expect(k.key).not.toBe(expected);
        expect(next?.key).toBe(expected);
        expect(next?.result === 'correct' || next?.result === 'completed').toBe(true);
        expect((next?.τ ?? 0) - k.τ).toBeGreaterThanOrEqual(200);
        expect((next?.τ ?? 0) - k.τ).toBeLessThan(400);
      });
    }
    expect(errors).toBeGreaterThan(300);
  });

  it('spaces keys by I·f·(1 + 0.35·(u1 + u2 − 1)) with f clamped to 0.7–1.4', () => {
    const profile: CpuProfile = { ...PROFILE, wpm: 120, nominalWpm: 120, err: 0 };
    const interval = 12000 / profile.nominalWpm;
    const words = typeWords(profile, 8, EASY_MEDIUM.slice(0, 400)).filter((w) => w.word.tier !== 'hard');
    const gaps = words.flatMap(correctGaps);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(interval * 0.7 * 0.65);
    expect(Math.max(...gaps)).toBeLessThan(interval * 1.4 * 1.35);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(mean / interval).toBeGreaterThan(0.97);
    expect(mean / interval).toBeLessThan(1.03);
  });

  it('hesitates 250–500 ms before about 10 % of the keys after the first of a hard word', () => {
    const profile: CpuProfile = { ...PROFILE, wpm: 120, nominalWpm: 120, err: 0 };
    const maxPlain = (12000 / profile.nominalWpm) * 1.4 * 1.35;
    const hard = typeWords(profile, 9, wordsOf(['hard'], 500), 'alwaysEasy').filter((w) => w.word.tier === 'hard');
    const gaps = hard.flatMap(correctGaps);
    const hesitations = gaps.filter((g) => g >= maxPlain);
    expect(hesitations.length / gaps.length).toBeGreaterThan(0.08);
    expect(hesitations.length / gaps.length).toBeLessThan(0.12);
    expect(Math.min(...hesitations)).toBeGreaterThanOrEqual(250);
    expect(Math.max(...hesitations)).toBeLessThan(500 + maxPlain);
  });
});

describe('CpuBrain — plan contract', () => {
  it('is deterministic: same seed and turn ⇒ same plan; calling plan twice ⇒ identical', () => {
    const a = new CpuBrain(0, PROFILE, 42);
    const b = new CpuBrain(0, PROFILE, 42);
    const t = returnTurn();
    const plan = a.plan(t);
    expect(b.plan(returnTurn())).toEqual(plan);
    expect(a.plan(t)).toEqual(plan);
    expect(new CpuBrain(0, PROFILE, 43).plan(returnTurn())).not.toEqual(plan);
  });

  it('hands out copies: editing a returned plan does not change the next one', () => {
    const brain = new CpuBrain(0, PROFILE, 42);
    const t = returnTurn();
    const plan = brain.plan(t);
    const copy = plan.map((k) => ({ ...k }));
    plan[0] = { key: 'x', τ: -1 };
    if (plan[1] !== undefined) plan[1].τ = -2;
    expect(brain.plan(t)).toEqual(copy);
  });

  it('seeds its RNG with exactly forkSeed(seed, player + 1): its first draw is the toss delay', () => {
    for (const player of [0, 1] as const) {
      const delay = 600 + 600 * uniform(seedRng(forkSeed(42, player + 1)));
      const toss = new CpuBrain(player, PROFILE, 42).plan(serveTurn({ owner: player }))[0];
      expect(toss?.key).toBe('toss');
      expect(toss?.τ).toBeCloseTo(2500 + delay, 9);
    }
  });

  it('returns exactly the not-yet-consumed rest of a fixed plan as inputs are fed, in τ order', () => {
    for (let seed = 0; seed < 20; seed++) {
      const brain = new CpuBrain(0, { ...PROFILE, err: 0.2 }, seed);
      const t = returnTurn();
      const full = brain.plan(t);
      full.slice(1).forEach((k, i) => expect(k.τ).toBeGreaterThanOrEqual(full[i]?.τ ?? Infinity));
      full.forEach((k, i) => {
        feed(t, k);
        expect(brain.plan(t)).toEqual(full.slice(i + 1));
      });
    }
  });

  it('returns only inputs at or after the turn clock, re-planning keys the clock has passed', () => {
    const brain = new CpuBrain(0, PROFILE, 6);
    const t = returnTurn();
    const full = brain.plan(t);
    const late = (full[0]?.τ ?? Number.NaN) + 1;
    t.τ = late;
    const rest = brain.plan(t);
    expect(rest[0]).toEqual({ key: 'r', τ: late }); // nothing of 'rally' was typed
    for (const k of rest) expect(k.τ).toBeGreaterThanOrEqual(late);
  });

  it('plans nothing for a turn it does not own, one not started, or one that has ended', () => {
    const brain = new CpuBrain(0, PROFILE, 1);
    expect(brain.plan(returnTurn({ owner: 1 }))).toEqual([]);
    expect(brain.plan(serveTurn({ owner: 1 }))).toEqual([]);
    const unstarted = returnTurn();
    unstarted.started = false;
    expect(brain.plan(unstarted)).toEqual([]);
    const ended = returnTurn();
    ended.ended = true;
    expect(brain.plan(ended)).toEqual([]);
  });

  it('plans nothing once the turn outcome is decided (e.g. an OUT call), even before the turn has ended', () => {
    const brain = new CpuBrain(0, PROFILE, 1);
    const t = returnTurn();
    expect(brain.plan(t).length).toBeGreaterThan(0);
    t.τ = 2400;
    t.outcome = { kind: 'call', endτ: 2400, call: 'out' };
    t.active = null;
    expect(brain.plan(t)).toEqual([]);
  });

  it('starts a word no earlier than the turn clock when it first sees the prompt late', () => {
    const late = returnTurn();
    late.τ = 5000;
    expect(new CpuBrain(0, PROFILE, 1).plan(late)[0]).toEqual({ key: 'r', τ: 5000 }); // 'rally'
    const brain = new CpuBrain(0, PROFILE, 1);
    const t = serveTurn();
    feed(t, brain.plan(t)[0] as PlannedKey);
    t.τ = (t.tossAt ?? 0) + 2000;
    expect(brain.plan(t)[0]?.τ).toBe(t.τ);
  });

  it('rejects profiles that would produce NaN or negative times', () => {
    const bad: CpuProfile[] = [
      { ...PROFILE, wpm: 0 },
      { ...PROFILE, wpm: -30 },
      { ...PROFILE, wpm: Number.NaN },
      { ...PROFILE, nominalWpm: 0 },
      { ...PROFILE, nominalWpm: Number.POSITIVE_INFINITY },
      { ...PROFILE, err: 1 },
      { ...PROFILE, err: -0.1 },
      { ...PROFILE, wordPauseMs: -1 },
      { ...PROFILE, serveChasePauseMs: Number.POSITIVE_INFINITY },
      { ...PROFILE, earlyPauseMs: Number.NaN },
      { ...PROFILE, aggression: Number.NaN },
    ];
    for (const profile of bad) expect(() => new CpuBrain(0, profile, 1)).toThrow(RangeError);
  });
});

describe('CPU and the insane option (power-meter spec §5)', () => {
  const EXACT: CpuProfile = { wpm: 120, nominalWpm: 120, err: 0, wordPauseMs: 300, serveChasePauseMs: 300, earlyPauseMs: 150, aggression: 1 };

  /** The first key the plan types after the chase word's last correct letter: the chosen option's initial. */
  function choiceInitial(keys: { key: string }[], chase: string): string | undefined {
    let i = 0;
    let typed = 0;
    for (; i < keys.length && typed < chase.length; i++) if (keys[i]!.key === chase[typed]) typed++;
    return keys[i]?.key;
  }

  it('serves the insane word when it fits and aggression is 1', () => {
    const t = createTurn(serveData({ owner: 0, power: 4, wordSets: [serveSet([...SET_A, 'quarterfinalist'])] }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    const keys = new CpuBrain(0, EXACT, 1).plan(t);
    expect(keys.map((k) => k.key).join('')).toBe('quarterfinalist');
  });

  it('plans the insane word for a clean chase, and never after a planned wrong key in the chase', () => {
    const clean = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(clean);
    expect(choiceInitial(new CpuBrain(1, EXACT, 1).plan(clean), 'ball')).toBe(INSANE_WORD[0]);
    for (let seed = 1; seed <= 20; seed++) {
      const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
      startTurn(t);
      const keys = new CpuBrain(1, { ...EXACT, err: 0.99 }, seed).plan(t);
      expect(choiceInitial(keys, 'ball'), `seed ${seed}`).not.toBe(INSANE_WORD[0]);
    }
  });

  it('neverInsane never picks insane; neverHard picks neither hard nor insane', () => {
    for (const [policy, banned] of [['neverInsane', ['p']], ['neverHard', ['c', 'p']]] as const) {
      const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
      startTurn(t);
      const initial = choiceInitial(new CpuBrain(1, EXACT, 1, { policy }).plan(t), 'ball');
      expect(banned, policy).not.toContain(initial);
    }
  });
});
