import { insaneOffered, levelFromKeys } from './power';
import { chance, forkSeed, intBelow, normalIH, seedRng, uniform } from './rng';
import { CPU_LEVEL_WPM, CPU_MILESTONES, CPU_NOMINAL_WPM, TUNING } from './tuning';
import { isComplete } from './typing';
import type { PlayerId, PromptState, ReturnTurnData, RngState, ServeTurnData, TurnState, WordOption } from './types';
import { TIERS } from './types';
import { clamp, lerp } from './util';

/** A typist's parameters (early-typing spec §5): label and nominal speed, per-key error rate, pauses before a prompt's first key, aggression. */
export interface CpuProfile {
  /** Label WPM: the average its Results screen shows. */
  wpm: number;
  /** The speed it types at underneath: mean key interval 12/nominalWpm s. */
  nominalWpm: number;
  err: number;
  /** Before a serve word (after the toss) and before choice words. */
  wordPauseMs: number;
  /** Before the chase word of a serve return. */
  serveChasePauseMs: number;
  /** Before a rally chase word, from when it is shown: the striker's lock (early typing). */
  earlyPauseMs: number;
  aggression: number;
}

/** One of the 15 CPU levels as shown to the player: belt with 0–2 stripes (or dan grade), WPM and label. */
export interface CpuLevelInfo {
  level: number;
  belt: 'white' | 'yellow' | 'green' | 'brown' | 'black';
  stripes: 0 | 1 | 2;
  dan: 0 | 2 | 3;
  wpm: number;
  label: string;
}

type Rank = Pick<CpuLevelInfo, 'belt' | 'stripes' | 'dan'>;

/** Belt, stripes and dan of each level (index = level); WPMs come from CPU_LEVEL_WPM. */
const RANKS: readonly Rank[] = [
  { belt: 'white', stripes: 0, dan: 0 },
  { belt: 'white', stripes: 1, dan: 0 },
  { belt: 'white', stripes: 2, dan: 0 },
  { belt: 'yellow', stripes: 0, dan: 0 },
  { belt: 'yellow', stripes: 1, dan: 0 },
  { belt: 'yellow', stripes: 2, dan: 0 },
  { belt: 'green', stripes: 0, dan: 0 },
  { belt: 'green', stripes: 1, dan: 0 },
  { belt: 'green', stripes: 2, dan: 0 },
  { belt: 'brown', stripes: 0, dan: 0 },
  { belt: 'brown', stripes: 1, dan: 0 },
  { belt: 'brown', stripes: 2, dan: 0 },
  { belt: 'black', stripes: 0, dan: 0 },
  { belt: 'black', stripes: 0, dan: 2 },
  { belt: 'black', stripes: 0, dan: 3 },
];

const DAN_ORDINALS: Record<2 | 3, string> = { 2: '2ND', 3: '3RD' };

function rankLabel(r: Rank): string {
  const belt = `${r.belt.toUpperCase()} BELT`;
  if (r.dan !== 0) return `${belt} ${DAN_ORDINALS[r.dan]} DAN`;
  return r.stripes === 0 ? belt : `${belt} ${'★'.repeat(r.stripes)}`;
}

/** WPM of a level; throws a RangeError for anything but an integer 0..14. */
function levelWpm(level: number): number {
  const wpm = Number.isInteger(level) ? CPU_LEVEL_WPM[level] : undefined;
  if (wpm === undefined) throw new RangeError(`CPU level must be an integer 0..${CPU_LEVEL_WPM.length - 1}, got ${level}`);
  return wpm;
}

/** The 15 CPU levels, easiest first (index = level); labels like 'GREEN BELT ★★' or 'BLACK BELT 2ND DAN'. */
export const CPU_LEVELS: CpuLevelInfo[] = RANKS.map((rank, level) => ({ level, ...rank, wpm: levelWpm(level), label: rankLabel(rank) }));

/** True for a level that is a milestone row of spec §3.8 (a belt with no stripes, or a dan grade). */
export function isMilestone(level: number): boolean {
  return CPU_LEVELS[level]?.stripes === 0;
}

/** Share of the way from the model's slowest row (25 WPM) to its fastest (140 WPM), held at the ends. */
function modelShare(wpm: number): number {
  const [lo, hi] = TUNING.typist.wpmRange;
  return clamp((wpm - lo) / (hi - lo), 0, 1);
}

/**
 * The typist model at label speed `wpm` (early-typing spec §5): error rate and pauses linear in WPM from
 * 25 to 140 and held outside; `nominalWpm` defaults to the calibrated speed for that label. Throws a
 * RangeError for a speed that is not finite and positive.
 */
export function typistProfile(wpm: number, aggression: number, nominalWpm: number = nominalWpmFor(wpm)): CpuProfile {
  if (!Number.isFinite(wpm) || wpm <= 0) throw new RangeError(`typistProfile: WPM must be finite and positive, got ${wpm}`);
  const m = TUNING.typist;
  const f = modelShare(wpm);
  return {
    wpm,
    nominalWpm,
    err: lerp(m.err[0], m.err[1], f),
    wordPauseMs: lerp(m.wordPauseMs[0], m.wordPauseMs[1], f),
    serveChasePauseMs: lerp(m.serveChasePauseMs[0], m.serveChasePauseMs[1], f),
    earlyPauseMs: lerp(m.earlyPauseMs[0], m.earlyPauseMs[1], f),
    aggression,
  };
}

/** Nominal speed for label `wpm`: CPU_NOMINAL_WPM, linear in label WPM between levels, and the end levels' ratio beyond them. */
export function nominalWpmFor(wpm: number): number {
  const labels: readonly number[] = CPU_LEVEL_WPM;
  const nominal: readonly number[] = CPU_NOMINAL_WPM;
  const last = labels.length - 1;
  if (wpm <= labels[0]!) return (wpm * nominal[0]!) / labels[0]!;
  if (wpm >= labels[last]!) return (wpm * nominal[last]!) / labels[last]!;
  const hi = labels.findIndex((l) => l >= wpm);
  return lerp(nominal[hi - 1]!, nominal[hi]!, (wpm - labels[hi - 1]!) / (labels[hi]! - labels[hi - 1]!));
}

/** Aggression at label `wpm` (early-typing spec §5): the milestone rows' values, linear in WPM between rows, held beyond them. */
export function aggressionAt(wpm: number): number {
  const rows = CPU_MILESTONES;
  const first = rows[0];
  const last = rows[rows.length - 1]!;
  if (wpm <= first.wpm) return first.aggression;
  if (wpm >= last.wpm) return last.aggression;
  const hi = rows.findIndex((r) => r.wpm >= wpm);
  const lo = rows[hi - 1]!;
  const top = rows[hi]!;
  return lerp(lo.aggression, top.aggression, (wpm - lo.wpm) / (top.wpm - lo.wpm));
}

/** Profile of a level: the typist model at its label WPM, with its calibrated nominal speed and its belt's aggression. */
export function cpuProfile(level: number): CpuProfile {
  const wpm = levelWpm(level);
  return typistProfile(wpm, aggressionAt(wpm), CPU_NOMINAL_WPM[level]!);
}

/** How the CPU picks a serve/choice word: spec §3.8's adaptive rule, or a fixed strategy for balance checks. neverHard never picks hard or insane; neverInsane never picks insane. */
export type CpuPolicy = 'adaptive' | 'alwaysEasy' | 'alwaysHard' | 'neverHard' | 'neverInsane';

/** Optional CpuBrain settings: `policy` defaults to 'adaptive'. */
export interface CpuBrainOptions { policy?: CpuPolicy }

/** One input the CPU will make: a letter or 'toss', at turn-clock τ (ms). */
export interface PlannedKey { key: string; τ: number }

/** CPU typing constants of spec §3.8 (times in ms); the model's pauses and error rates are in TUNING.typist. */
const CPU = {
  tossDelay: { min: 600, max: 1200 },
  secondServeAggression: 0.4,
  wordFactor: { perZ: 0.15, min: 0.7, max: 1.4 },
  intervalSpread: 0.35,
  hesitation: { chance: 0.1, min: 250, max: 500 },
  safetyMs: 250,
} as const;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * The plan for one prompt shown (or expected) at `shownAt`: the option it types, and its inputs
 * from the prompt's `from`-th input (correct or wrong key) on.
 */
interface PromptPlan { shownAt: number; option: number; from: number; keys: PlannedKey[] }

/** Planner for one CPU player. Deterministic given (seed, the turn states it sees). */
export class CpuBrain {
  private readonly player: PlayerId;
  private readonly profile: CpuProfile;
  private readonly policy: CpuPolicy;
  private readonly rng: RngState;
  /** Turn the plans below belong to; they are dropped when another turn id is seen. */
  private turnId: number | null = null;
  /** Plan per prompt, keyed `turnId:promptId`; fixed once made unless a planned key is skipped. */
  private readonly promptPlans = new Map<string, PromptPlan>();
  /** Planned toss τ per PRE_SERVE, keyed `turnId:setIndex`, before clamping to the turn clock. */
  private readonly tossPlans = new Map<string, number>();

  constructor(player: PlayerId, profile: CpuProfile, seed: number, opts: CpuBrainOptions = {}) {
    if (!isValidProfile(profile)) throw new RangeError(`CpuBrain: invalid profile ${JSON.stringify(profile)}`);
    this.player = player;
    this.profile = { ...profile };
    this.policy = opts.policy ?? 'adaptive';
    this.rng = seedRng(forkSeed(seed, player + 1));
  }

  /** Inputs the CPU will make for the current turn state, in τ order, from its current position on. Stable across calls for the same prompt. */
  plan(t: TurnState): PlannedKey[] {
    this.enterTurn(t.data.turnId);
    if (!t.started || t.ended || t.outcome !== null || t.data.owner !== this.player) return [];
    const keys = t.data.kind === 'serve' ? this.planServe(t, t.data) : this.planReturn(t, t.data);
    return keys.map((k) => ({ ...k }));
  }

  /** Drops the plans of earlier turns when a new turn id is seen (ids restart when the brain plays another match). */
  private enterTurn(turnId: number): void {
    if (turnId === this.turnId) return;
    this.turnId = turnId;
    this.promptPlans.clear();
    this.tossPlans.clear();
  }

  /** PRE_SERVE: the toss. TOSS: a word pause + keys of the chosen serve word, judged against tossAt + 2a from now. */
  private planServe(t: TurnState, d: ServeTurnData): PlannedKey[] {
    if (t.phase === 'preServe') {
      return d.wordSets[t.setIndex] === undefined ? [] : [{ key: 'toss', τ: Math.max(this.tossPlan(t, d), t.τ) }];
    }
    const prompt = t.phase === 'toss' && t.active !== null ? t.prompts[t.active] : undefined;
    if (prompt?.kind !== 'serve') return [];
    const plan = this.promptPlan(t, prompt.id, prompt.shownAt, prompt.options.length, () => {
      const deadline = (t.tossAt ?? prompt.shownAt) + 2 * d.tossApexMs * d.pace;
      const aggression = this.profile.aggression * (d.serveNo === 2 ? CPU.secondServeAggression : 1);
      const option = this.choose(prompt.options, deadline - Math.max(prompt.shownAt, t.τ), aggression);
      return this.newPlan(prompt.options, option, prompt.shownAt, this.profile.wordPauseMs, t.τ);
    });
    return this.rest(plan, prompt, t.τ);
  }

  /**
   * Chase keys a serve-return pause (serve return) or an early pause (rally) after the chase is shown,
   * then the choice keys a word pause after the chase completes, judged against T from now.
   */
  private planReturn(t: TurnState, d: ReturnTurnData): PlannedKey[] {
    const chase = t.prompts.find((p) => p.kind === 'chase');
    const choice = t.prompts.find((p) => p.kind === 'choice');
    const chaseShownAt = chase?.shownAt ?? 0;
    const chasePause = d.isServeReturn ? this.profile.serveChasePauseMs : this.profile.earlyPauseMs;
    const chasePlan = this.promptPlan(t, chase?.id ?? d.promptBase, chaseShownAt, 1, () =>
      this.newPlan([d.chase], 0, chaseShownAt, chasePause, t.τ),
    );
    const chaseKeys = this.rest(chasePlan, chase, t.τ);
    const choiceShownAt = choice?.shownAt ?? chaseKeys[chaseKeys.length - 1]?.τ;
    if (choiceShownAt === undefined) return chaseKeys;
    // A planned wrong key in the rest of the chase empties the meter, so the choice will show 3 options.
    const chaseClean = chaseKeys.length === d.chase.len - (chase?.typed ?? 0);
    const level = chaseClean ? levelFromKeys(t, t.τ) : 0;
    const options = choice?.options ?? (insaneOffered(level) ? d.choice.options : d.choice.options.slice(0, TIERS.length));
    const choicePlan = this.promptPlan(t, choice?.id ?? d.promptBase + 1, choiceShownAt, options.length, () => {
      const option = this.choose(options, d.incoming.T - Math.max(choiceShownAt, t.τ), this.profile.aggression);
      return this.newPlan(options, option, choiceShownAt, this.profile.wordPauseMs, t.τ);
    });
    return [...chaseKeys, ...this.rest(choicePlan, choice, t.τ)];
  }

  /** Planned toss τ for the current PRE_SERVE: its start + U(600, 1200), drawn once. */
  private tossPlan(t: TurnState, d: ServeTurnData): number {
    const key = `${d.turnId}:${t.setIndex}`;
    let τ = this.tossPlans.get(key);
    if (τ === undefined) {
      τ = preServeStart(t, d) + uniformIn(this.rng, CPU.tossDelay.min, CPU.tossDelay.max);
      this.tossPlans.set(key, τ);
    }
    return τ;
  }

  /**
   * The plan of a prompt shown (or expected) at `shownAt`, made once. A plan made for another shownAt,
   * or aimed at an option the prompt no longer offers, is replaced.
   */
  private promptPlan(t: TurnState, id: number, shownAt: number, optionCount: number, make: () => PromptPlan): PromptPlan {
    const key = `${t.data.turnId}:${id}`;
    const cached = this.promptPlans.get(key);
    if (cached?.shownAt === shownAt && cached.option < optionCount) return cached;
    const plan = make();
    this.promptPlans.set(key, plan);
    return plan;
  }

  /** A plan to type `options[option]` in full, its first key `pauseMs` after `shownAt` and never before τ. */
  private newPlan(options: readonly WordOption[], option: number, shownAt: number, pauseMs: number, τ: number): PromptPlan {
    return { shownAt, option, from: 0, keys: this.typeWord(options[option], 0, Math.max(shownAt + pauseMs, τ)) };
  }

  /**
   * The plan's keys not yet typed (every planned key lands as a correct or a wrong key). If the turn
   * clock τ has passed the next of them (a driver skipped it), the rest of the prompt is re-planned
   * from its actual state (typed count, locked option) starting at τ.
   */
  private rest(plan: PromptPlan, prompt: PromptState | undefined, τ: number): PlannedKey[] {
    if (prompt === undefined) return plan.keys;
    if (isComplete(prompt)) return [];
    const used = prompt.correctKeys + prompt.wrongKeys;
    const keys = plan.keys.slice(used - plan.from);
    if (keys[0] === undefined || keys[0].τ >= τ) return keys;
    plan.from = used;
    plan.keys = this.typeWord(prompt.options[prompt.locked ?? plan.option], prompt.typed, τ);
    return plan.keys;
  }

  /**
   * Option index to type (options are in tier order easy, medium, hard[, insane]). Adaptive: an option fits if
   * its estimate ≤ budget − 250 ms; with probability `aggression` the hardest fitting one, otherwise
   * a uniform pick among the other fitting ones; easy if none fits.
   */
  private choose(options: readonly WordOption[], budgetMs: number, aggression: number): number {
    if (this.policy === 'alwaysEasy') return 0;
    if (this.policy === 'alwaysHard') return options.length - 1;
    const banned = (o: WordOption): boolean =>
      (this.policy === 'neverHard' && (o.tier === 'hard' || o.tier === 'insane')) ||
      (this.policy === 'neverInsane' && o.tier === 'insane');
    const fitting = options.flatMap((o, i) => (banned(o) || this.estimateMs(o.len) > budgetMs - CPU.safetyMs ? [] : [i]));
    const hardest = fitting[fitting.length - 1];
    if (hardest === undefined) return 0;
    const others = fitting.slice(0, -1);
    if (others.length === 0 || chance(this.rng, aggression)) return hardest;
    return others[intBelow(this.rng, others.length)] ?? hardest;
  }

  /** est = word pause + len·I·(1 + err/(1 − err)) + err·len·mean wrong-key pause (early-typing spec §5). */
  private estimateMs(len: number): number {
    const { err, wordPauseMs } = this.profile;
    const { min, max } = TUNING.typist.wrongPauseRangeMs;
    return wordPauseMs + len * this.intervalMs() * (1 + err / (1 - err)) + err * len * ((min + max) / 2);
  }

  /** Mean key interval I = 12/nominal WPM s, in ms. */
  private intervalMs(): number {
    return 12000 / this.profile.nominalWpm;
  }

  /**
   * Keys of `word` from letter `from` on, the first at `start`: per-word factor f, jittered intervals,
   * hesitations on hard words, and errors (never on a prompt's first key) followed by the right letter
   * 200–400 ms later.
   */
  private typeWord(word: WordOption | undefined, from: number, start: number): PlannedKey[] {
    if (word === undefined) return [];
    const { rng } = this;
    const f = clamp(1 + CPU.wordFactor.perZ * normalIH(rng), CPU.wordFactor.min, CPU.wordFactor.max);
    const keys: PlannedKey[] = [];
    let τ = start;
    for (let i = from; i < word.word.length; i++) {
      const letter = word.word.charAt(i);
      if (i > from) {
        τ += this.intervalMs() * f * (1 + CPU.intervalSpread * (uniform(rng) + uniform(rng) - 1));
        if ((word.tier === 'hard' || word.tier === 'insane') && chance(rng, CPU.hesitation.chance)) τ += uniformIn(rng, CPU.hesitation.min, CPU.hesitation.max);
      }
      if (i > 0 && chance(rng, this.profile.err)) {
        keys.push({ key: wrongLetter(rng, letter), τ });
        τ += uniformIn(rng, TUNING.typist.wrongPauseRangeMs.min, TUNING.typist.wrongPauseRangeMs.max);
      }
      keys.push({ key: letter, τ });
    }
    return keys;
  }
}

/** Finite positive speeds, 0 ≤ err < 1, finite non-negative pauses, finite aggression: no NaN or negative times. */
function isValidProfile(p: CpuProfile): boolean {
  return (
    Number.isFinite(p.wpm) && p.wpm > 0 &&
    Number.isFinite(p.nominalWpm) && p.nominalWpm > 0 &&
    p.err >= 0 && p.err < 1 &&
    isDelayMs(p.wordPauseMs) && isDelayMs(p.serveChasePauseMs) && isDelayMs(p.earlyPauseMs) &&
    Number.isFinite(p.aggression)
  );
}

/** A finite, non-negative delay in ms. */
function isDelayMs(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0;
}

/** τ at which the current PRE_SERVE began: the end of the last catch, else the end of the lead-in. */
function preServeStart(t: TurnState, d: ServeTurnData): number {
  for (let i = t.log.length - 1; i >= 0; i--) {
    const e = t.log[i];
    if (e?.k === 'catch') return e.τ + d.catchMs;
  }
  return d.leadIn.ms;
}

function uniformIn(rng: RngState, min: number, max: number): number {
  return min + (max - min) * uniform(rng);
}

/** A uniformly random letter other than `right`. */
function wrongLetter(rng: RngState, right: string): string {
  const others = ALPHABET.replace(right, '');
  return others.charAt(intBelow(rng, others.length));
}
