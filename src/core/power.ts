import { TUNING } from './tuning';
import { TIERS, type ReturnTurnData, type TurnState, type WordOption } from './types';

/** A full power meter (power-meter spec §4.1). */
export const POWER_MAX: number = TUNING.power.max;

/** True when a meter level offers the insane option: the meter is on and full (power-meter spec §4.2). */
export function insaneOffered(level: number | null): boolean {
  return level !== null && level >= POWER_MAX;
}

/**
 * The turn owner's meter level at τ from its keys alone: the start level until the first wrong key
 * at or before τ, then 0 (power-meter spec §4.1). Null when the meter is off (training). Reads only
 * the log's 'bad' entries, never letters, so it works on redacted turns.
 */
export function levelFromKeys(t: TurnState, τ: number): number | null {
  const start = t.data.power;
  if (start === null) return null;
  for (const e of t.log) {
    if (e.τ > τ) break;
    if (e.k === 'bad') return 0;
  }
  return start;
}

/** The level after a strike whose word had `slips` slips: one more (capped) when flawless, else unchanged. */
export function levelAfterStrike(level: number, slips: number): number {
  return slips === 0 ? Math.min(POWER_MAX, level + 1) : level;
}

/**
 * The turn owner's meter level at τ (power-meter spec §4.1): `levelFromKeys`, plus one for a flawless
 * strike at or before τ. A turn that ends without a strike (a fault, a miss, a cancelling OUT/NET
 * call) never fills the meter. Null when the meter is off.
 */
export function powerAt(t: TurnState, τ: number): number | null {
  const level = levelFromKeys(t, τ);
  if (level === null) return null;
  const o = t.outcome;
  return o?.kind === 'strike' && o.strike.τ <= τ ? levelAfterStrike(level, o.strike.slips) : level;
}

/**
 * The choice prompt's options when it is shown at τ (power-meter spec §4.2): every pre-picked option
 * while the meter is still full, else the first three (a wrong key in the chase emptied it).
 */
export function choiceOptions(t: TurnState, d: ReturnTurnData, τ: number): WordOption[] {
  return insaneOffered(levelFromKeys(t, τ)) ? d.choice.options : d.choice.options.slice(0, TIERS.length);
}
