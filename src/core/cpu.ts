import { insaneOffered, levelFromKeys } from './power';
import { chance, forkSeed, intBelow, normalIH, seedRng, uniform } from './rng';
import { CPU_LEVEL_WPM, CPU_MILESTONES } from './tuning';
import { isComplete } from './typing';
import type { PlayerId, PromptState, ReturnTurnData, RngState, ServeTurnData, TurnState, WordOption } from './types';
import { TIERS } from './types';
import { clamp, lerp } from './util';

/** A CPU typist's parameters (spec §3.8): speed, per-key error rate, reaction before a prompt's first key, aggression. */
export interface CpuProfile { wpm: number; err: number; reactionMs: number; aggression: number }

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

/** Profile of a level: its milestone row, or a linear interpolation in WPM between the two milestone rows around it. */
export function cpuProfile(level: number): CpuProfile {
  const wpm = levelWpm(level);
  const hiIndex = CPU_MILESTONES.findIndex((m) => m.wpm >= wpm);
  const hi = CPU_MILESTONES[hiIndex];
  const lo = CPU_MILESTONES[hiIndex - 1];
  if (hi === undefined) throw new RangeError(`CPU level ${level} (${wpm} WPM) is above the fastest milestone row`);
  if (lo === undefined || hi.wpm === wpm) return { wpm, err: hi.err, reactionMs: hi.reactionMs, aggression: hi.aggression };
  const f = (wpm - lo.wpm) / (hi.wpm - lo.wpm);
  return {
    wpm,
    err: lerp(lo.err, hi.err, f),
    reactionMs: lerp(lo.reactionMs, hi.reactionMs, f),
    aggression: lerp(lo.aggression, hi.aggression, f),
  };
}

/** How the CPU picks a serve/choice word: spec §3.8's adaptive rule, or a fixed strategy for balance checks. neverHard never picks hard or insane; neverInsane never picks insane. */
export type CpuPolicy = 'adaptive' | 'alwaysEasy' | 'alwaysHard' | 'neverHard' | 'neverInsane';

/**
 * Optional CpuBrain settings: `policy` defaults to 'adaptive'; `chaseReactionMs` (ms, finite, ≥ 0)
 * replaces the reaction before a chase word's first key, for rally and serve-return chases alike.
 */
export interface CpuBrainOptions { policy?: CpuPolicy; chaseReactionMs?: number }

/** One input the CPU will make: a letter or 'toss', at turn-clock τ (ms). */
export interface PlannedKey { key: string; τ: number }

/** CPU typing constants of spec §3.8 (times in ms). */
const CPU = {
  tossDelay: { min: 600, max: 1200 },
  rallyChaseReaction: 0.5,
  secondServeAggression: 0.4,
  wordFactor: { perZ: 0.15, min: 0.7, max: 1.4 },
  intervalSpread: 0.35,
  hesitation: { chance: 0.1, min: 250, max: 500 },
  errorPause: { min: 150, max: 300 },
  errorEstimateMs: 225,
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
  private readonly chaseReactionMs: number | undefined;
  private readonly rng: RngState;
  /** Turn the plans below belong to; they are dropped when another turn id is seen. */
  private turnId: number | null = null;
  /** Plan per prompt, keyed `turnId:promptId`; fixed once made unless a planned key is skipped. */
  private readonly promptPlans = new Map<string, PromptPlan>();
  /** Planned toss τ per PRE_SERVE, keyed `turnId:setIndex`, before clamping to the turn clock. */
  private readonly tossPlans = new Map<string, number>();

  constructor(player: PlayerId, profile: CpuProfile, seed: number, opts: CpuBrainOptions = {}) {
    if (!isValidProfile(profile)) throw new RangeError(`CpuBrain: invalid profile ${JSON.stringify(profile)}`);
    const { chaseReactionMs } = opts;
    if (chaseReactionMs !== undefined && !isDelayMs(chaseReactionMs)) {
      throw new RangeError(`CpuBrain: invalid chaseReactionMs ${chaseReactionMs}`);
    }
    this.player = player;
    this.profile = { ...profile };
    this.policy = opts.policy ?? 'adaptive';
    this.chaseReactionMs = chaseReactionMs;
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

  /** PRE_SERVE: the toss. TOSS: reaction + keys of the chosen serve word, judged against tossAt + 2a from now. */
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
      return this.newPlan(prompt.options, option, prompt.shownAt, this.profile.reactionMs, t.τ);
    });
    return this.rest(plan, prompt, t.τ);
  }

  /**
   * Chase keys after the chase reaction (default: half a reaction for a rally ball, a full one for a
   * serve return), then the choice keys a full reaction after the chase completes, judged against T from now.
   */
  private planReturn(t: TurnState, d: ReturnTurnData): PlannedKey[] {
    const chase = t.prompts.find((p) => p.kind === 'chase');
    const choice = t.prompts.find((p) => p.kind === 'choice');
    const chaseShownAt = chase?.shownAt ?? 0;
    const chaseReactionMs = this.chaseReactionMs ?? this.profile.reactionMs * (d.isServeReturn ? 1 : CPU.rallyChaseReaction);
    const chasePlan = this.promptPlan(t, chase?.id ?? d.promptBase, chaseShownAt, 1, () =>
      this.newPlan([d.chase], 0, chaseShownAt, chaseReactionMs, t.τ),
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
      return this.newPlan(options, option, choiceShownAt, this.profile.reactionMs, t.τ);
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

  /** A plan to type `options[option]` in full, its first key a reaction after `shownAt` and never before τ. */
  private newPlan(options: readonly WordOption[], option: number, shownAt: number, reactionMs: number, τ: number): PromptPlan {
    return { shownAt, option, from: 0, keys: this.typeWord(options[option], 0, Math.max(shownAt + reactionMs, τ)) };
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

  /** Spec §3.8: est = reaction + len·I·(1 + err/(1 − err)) + err·len·225 ms. */
  private estimateMs(len: number): number {
    const { err, reactionMs } = this.profile;
    return reactionMs + len * this.intervalMs() * (1 + err / (1 - err)) + err * len * CPU.errorEstimateMs;
  }

  /** Mean key interval I = 12/WPM s, in ms. */
  private intervalMs(): number {
    return 12000 / this.profile.wpm;
  }

  /**
   * Keys of `word` from letter `from` on, the first at `start`: per-word factor f, jittered intervals,
   * hesitations on hard words, and errors (never on a prompt's first key) followed by the right letter
   * 150–300 ms later.
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
        τ += uniformIn(rng, CPU.errorPause.min, CPU.errorPause.max);
      }
      keys.push({ key: letter, τ });
    }
    return keys;
  }
}

/** Finite positive WPM, 0 ≤ err < 1, finite non-negative reaction, finite aggression: no NaN or negative times. */
function isValidProfile({ wpm, err, reactionMs, aggression }: CpuProfile): boolean {
  return (
    Number.isFinite(wpm) && wpm > 0 &&
    err >= 0 && err < 1 &&
    isDelayMs(reactionMs) &&
    Number.isFinite(aggression)
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
