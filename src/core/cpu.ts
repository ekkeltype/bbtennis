import { chance, forkSeed, intBelow, normalIH, seedRng, uniform } from './rng';
import { CPU_LEVEL_WPM, CPU_MILESTONES } from './tuning';
import { isComplete } from './typing';
import type { PlayerId, PromptState, ReturnTurnData, RngState, ServeTurnData, TurnState, WordOption } from './types';
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

/** How the CPU picks a serve/choice word: spec §3.8's adaptive rule, or a fixed strategy for balance checks. */
export type CpuPolicy = 'adaptive' | 'alwaysEasy' | 'alwaysHard' | 'neverHard';

/** Optional CpuBrain settings; `policy` defaults to 'adaptive'. */
export interface CpuBrainOptions { policy?: CpuPolicy }

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

/** Planner for one CPU player. Deterministic given (seed, the turn states it sees). */
export class CpuBrain {
  private readonly player: PlayerId;
  private readonly profile: CpuProfile;
  private readonly policy: CpuPolicy;
  private readonly rng: RngState;
  /** Keys planned per prompt id; a prompt's plan is fixed once made. */
  private readonly promptPlans = new Map<number, PlannedKey[]>();
  /** Planned toss τ per PRE_SERVE (turn id + word set index), before clamping to the turn clock. */
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
    if (!t.started || t.ended || t.outcome !== null || t.data.owner !== this.player) return [];
    const keys = t.data.kind === 'serve' ? this.planServe(t, t.data) : this.planReturn(t, t.data);
    return keys.map((k) => ({ ...k }));
  }

  /** PRE_SERVE: the toss. TOSS: reaction + keys of the chosen serve word, judged against tossAt + 2a. */
  private planServe(t: TurnState, d: ServeTurnData): PlannedKey[] {
    if (t.phase === 'preServe') {
      return d.wordSets[t.setIndex] === undefined ? [] : [{ key: 'toss', τ: Math.max(this.tossPlan(t, d), t.τ) }];
    }
    const prompt = t.phase === 'toss' && t.active !== null ? t.prompts[t.active] : undefined;
    if (prompt?.kind !== 'serve') return [];
    const keys = this.promptPlan(prompt.id, () => {
      const deadline = (t.tossAt ?? prompt.shownAt) + 2 * d.tossApexMs * d.pace;
      const aggression = this.profile.aggression * (d.serveNo === 2 ? CPU.secondServeAggression : 1);
      const word = prompt.options[this.choose(prompt.options, deadline - prompt.shownAt, aggression)];
      return this.typeWord(word, Math.max(prompt.shownAt + this.profile.reactionMs, t.τ));
    });
    return unconsumed(keys, prompt, t.τ);
  }

  /** Chase keys after a (half, for rally balls) reaction, then the choice keys a full reaction after the chase completes. */
  private planReturn(t: TurnState, d: ReturnTurnData): PlannedKey[] {
    const chase = t.prompts.find((p) => p.kind === 'chase');
    const choice = t.prompts.find((p) => p.kind === 'choice');
    const chaseReactionMs = this.profile.reactionMs * (d.isServeReturn ? 1 : CPU.rallyChaseReaction);
    const chaseKeys = this.promptPlan(chase?.id ?? d.promptBase, () =>
      this.typeWord(d.chase, Math.max((chase?.shownAt ?? 0) + chaseReactionMs, t.τ)),
    );
    const choiceKeys = this.promptPlan(choice?.id ?? d.promptBase + 1, () => {
      const shownAt = choice?.shownAt ?? chaseKeys[chaseKeys.length - 1]?.τ ?? t.τ;
      const word = d.choice.options[this.choose(d.choice.options, d.incoming.T - shownAt, this.profile.aggression)];
      return this.typeWord(word, Math.max(shownAt + this.profile.reactionMs, t.τ));
    });
    return [...unconsumed(chaseKeys, chase, t.τ), ...unconsumed(choiceKeys, choice, t.τ)];
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

  private promptPlan(id: number, make: () => PlannedKey[]): PlannedKey[] {
    let keys = this.promptPlans.get(id);
    if (keys === undefined) {
      keys = make();
      this.promptPlans.set(id, keys);
    }
    return keys;
  }

  /**
   * Option index to type (options are in tier order easy, medium, hard). Adaptive: an option fits if
   * its estimate ≤ budget − 250 ms; with probability `aggression` the hardest fitting one, otherwise
   * a uniform pick among the other fitting ones; easy if none fits.
   */
  private choose(options: readonly WordOption[], budgetMs: number, aggression: number): number {
    if (this.policy === 'alwaysEasy') return 0;
    if (this.policy === 'alwaysHard') return options.length - 1;
    const fitting = options.flatMap((o, i) =>
      (this.policy === 'neverHard' && o.tier === 'hard') || this.estimateMs(o.len) > budgetMs - CPU.safetyMs ? [] : [i],
    );
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
   * Keys of one word from `start`: per-word factor f, jittered intervals, hesitations on hard words,
   * and errors (never on the first key) followed by the right letter 150–300 ms later.
   */
  private typeWord(word: WordOption | undefined, start: number): PlannedKey[] {
    if (word === undefined) return [];
    const { rng } = this;
    const f = clamp(1 + CPU.wordFactor.perZ * normalIH(rng), CPU.wordFactor.min, CPU.wordFactor.max);
    const keys: PlannedKey[] = [];
    let τ = start;
    [...word.word].forEach((letter, i) => {
      if (i > 0) {
        τ += this.intervalMs() * f * (1 + CPU.intervalSpread * (uniform(rng) + uniform(rng) - 1));
        if (word.tier === 'hard' && chance(rng, CPU.hesitation.chance)) τ += uniformIn(rng, CPU.hesitation.min, CPU.hesitation.max);
        if (chance(rng, this.profile.err)) {
          keys.push({ key: wrongLetter(rng, letter), τ });
          τ += uniformIn(rng, CPU.errorPause.min, CPU.errorPause.max);
        }
      }
      keys.push({ key: letter, τ });
    });
    return keys;
  }
}

/** Finite positive WPM, 0 ≤ err < 1, finite non-negative reaction, finite aggression: no NaN or negative times. */
function isValidProfile({ wpm, err, reactionMs, aggression }: CpuProfile): boolean {
  return (
    Number.isFinite(wpm) && wpm > 0 &&
    err >= 0 && err < 1 &&
    Number.isFinite(reactionMs) && reactionMs >= 0 &&
    Number.isFinite(aggression)
  );
}

/** τ at which the current PRE_SERVE began: the end of the last catch, else the end of the lead-in. */
function preServeStart(t: TurnState, d: ServeTurnData): number {
  for (let i = t.log.length - 1; i >= 0; i--) {
    const e = t.log[i];
    if (e?.k === 'catch') return e.τ + d.catchMs;
  }
  return d.leadIn.ms;
}

/** The keys of a prompt's plan not yet typed (every planned key is either correct or wrong), at or after τ. */
function unconsumed(keys: readonly PlannedKey[], prompt: PromptState | undefined, τ: number): PlannedKey[] {
  if (prompt !== undefined && isComplete(prompt)) return [];
  const consumed = prompt === undefined ? 0 : prompt.correctKeys + prompt.wrongKeys;
  return keys.slice(consumed).filter((k) => k.τ >= τ);
}

function uniformIn(rng: RngState, min: number, max: number): number {
  return min + (max - min) * uniform(rng);
}

/** A uniformly random letter other than `right`. */
function wrongLetter(rng: RngState, right: string): string {
  const others = ALPHABET.replace(right, '');
  return others.charAt(intBelow(rng, others.length));
}
