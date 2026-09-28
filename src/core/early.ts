import { MAX_EARLY_KEYS } from './turn';
import { other, type EarlyKey, type EventBody, type GameEvent, type PlayerId, type PromptState, type TurnState } from './types';
import { applyLetter, createPrompt, isComplete, wordCps, wpmOf } from './typing';

/** Prompt id of an early chase's feedback events: the receiver's real chase prompt does not exist before the strike. */
export const EARLY_PROMPT = -1;

const LETTER = /^[a-z]$/;

/**
 * A chase word typed early (early-typing spec §2): what a session keeps for the receiver while the
 * striker's return turn is shown, from its choice lock to its strike. Times are on the striker's turn
 * clock; `keysAt` re-bases them to the receiver's for `Engine.start`.
 */
export class EarlyChase {
  private readonly keys: EarlyKey[] = [];

  private constructor(
    /** The receiver: the player who will chase the word. */
    readonly player: PlayerId,
    /** The striker's turn, whose choice lock opened the window. */
    readonly turnId: number,
    /** The lock's τ on the striker's clock. */
    readonly lockτ: number,
    /** The chase prompt: the locked word, shown at the lock. */
    readonly prompt: PromptState,
    /** The receiver's meter level (null = meter off), for the feedback of a first wrong key. */
    private level: number | null,
  ) {}

  /**
   * The early chase of return turn `t` for its receiver once `t`'s choice word is locked at or before τ
   * (t's clock), with the event that shows it; null for any other turn. `power` is the receiver's meter
   * level (null = meter off).
   */
  static open(t: TurnState, τ: number, power: number | null): { chase: EarlyChase; events: GameEvent[] } | null {
    if (t.data.kind !== 'return') return null;
    const lock = t.log.find((e) => e.k === 'lock');
    if (lock?.k !== 'lock' || lock.τ > τ) return null;
    const word = t.prompts.find((p) => p.id === lock.prompt)?.options[lock.option];
    if (word === undefined || word.hidden === true) return null;
    const player = other(t.data.owner);
    const prompt = createPrompt(EARLY_PROMPT, 'chase', [{ ...word }], lock.τ);
    const chase = new EarlyChase(player, t.data.turnId, lock.τ, prompt, power);
    return { chase, events: [chase.event(lock.τ, { type: 'promptShown', player, prompt: EARLY_PROMPT, kind: 'chase' })] };
  }

  /** How many keys it has taken (at most MAX_EARLY_KEYS). */
  get count(): number {
    return this.keys.length;
  }

  /**
   * A letter at τ on the striker's clock, taken no earlier than the lock or the previous key: applied
   * with the chase rules; returns the feedback events for the typist's own view. Ignored once the word
   * is complete or MAX_EARLY_KEYS keys were taken.
   */
  press(letter: string, τ: number): GameEvent[] {
    if (!LETTER.test(letter) || isComplete(this.prompt) || this.keys.length >= MAX_EARLY_KEYS) return [];
    const at = Math.max(τ, this.keys.at(-1)?.τ ?? this.lockτ, this.lockτ);
    const result = applyLetter(this.prompt, letter, at);
    if (result === 'ignored') return [];
    this.keys.push({ key: letter, τ: at });
    const { player } = this;
    const prompt = EARLY_PROMPT;
    if (result === 'wrong') {
      const out = [this.event(at, { type: 'keyBad', player, prompt })];
      if (this.level !== null && this.level > 0) {
        out.push(this.event(at, { type: 'power', player, from: this.level, to: 0 }));
        this.level = 0;
      }
      return out;
    }
    const out = [this.event(at, { type: 'keyOk', player, prompt })];
    if (result === 'completed') out.push(this.event(at, { type: 'wordDone', player, prompt, wpm: wpmOf(wordCps(this.prompt)) }));
    return out;
  }

  /** The keys on the receiver's clock for a strike at `strikeτ` (striker's clock): τ − strikeτ; keys after the strike are left out. */
  keysAt(strikeτ: number): EarlyKey[] {
    return this.keys.filter((k) => k.τ <= strikeτ).map((k) => ({ key: k.key, τ: k.τ - strikeτ }));
  }

  private event(τ: number, body: EventBody): GameEvent {
    return { turn: this.turnId, τ, ...body };
  }
}

/**
 * The events a view shows (early-typing spec §6.4): a turn's events stamped before τ 0 are early keys
 * applied at its start, which their typist already saw live, or which a remote viewer skips.
 */
export function withoutEarlyEvents(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((e) => e.τ >= 0);
}
