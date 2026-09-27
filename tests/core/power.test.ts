import { describe, expect, it } from 'vitest';
import { choiceOptions, insaneOffered, levelAfterStrike, levelFromKeys, POWER_MAX, powerAt } from '../../src/core/power';
import { createTurn } from '../../src/core/turn';
import { TUNING } from '../../src/core/tuning';
import type { StrikeInfo, TurnLogEntry, TurnState } from '../../src/core/types';
import { CHOICE, INSANE_WORD, opt, returnData } from './turnFixtures';

const bad = (τ: number): TurnLogEntry => ({ τ, k: 'bad', prompt: 48, ch: 'z' });

/** A return turn with meter level `power` at its start, log `log` and, optionally, a strike at τ with `slips`. */
function turn(power: number | null, log: TurnLogEntry[] = [], strike?: { τ: number; slips: number }): TurnState {
  const t = createTurn(returnData({ power }));
  t.log = log;
  if (strike) t.outcome = { kind: 'strike', endτ: strike.τ, strike: { τ: strike.τ, slips: strike.slips } as StrikeInfo };
  return t;
}

describe('power meter rules (power-meter spec §4.1)', () => {
  it('fills to 4', () => {
    expect(TUNING.power.max).toBe(4);
    expect(POWER_MAX).toBe(4);
  });

  it('offers insane only at a full, switched-on meter', () => {
    expect(insaneOffered(null)).toBe(false);
    expect(insaneOffered(3)).toBe(false);
    expect(insaneOffered(4)).toBe(true);
  });

  it('keeps the start level until the first wrong key, then 0; null when the meter is off', () => {
    const t = turn(3, [bad(500), bad(900)]);
    expect(levelFromKeys(t, 499)).toBe(3);
    expect(levelFromKeys(t, 500)).toBe(0);
    expect(levelFromKeys(t, 10_000)).toBe(0);
    expect(levelFromKeys(turn(null, [bad(1)]), 5)).toBeNull();
  });

  it('adds one for a flawless strike, capped at 4; a slipped strike adds nothing', () => {
    expect(levelAfterStrike(0, 0)).toBe(1);
    expect(levelAfterStrike(3, 0)).toBe(4);
    expect(levelAfterStrike(4, 0)).toBe(4);
    expect(levelAfterStrike(2, 1)).toBe(2);
  });

  it('powerAt: the fill lands at the strike τ; a chase slip then a flawless shot leaves 1', () => {
    const clean = turn(2, [], { τ: 3000, slips: 0 });
    expect(powerAt(clean, 2999)).toBe(2);
    expect(powerAt(clean, 3000)).toBe(3);
    const slipped = turn(4, [bad(200)], { τ: 3000, slips: 0 });
    expect(powerAt(slipped, 100)).toBe(4);
    expect(powerAt(slipped, 200)).toBe(0);
    expect(powerAt(slipped, 3000)).toBe(1);
    expect(powerAt(turn(null, [], { τ: 10, slips: 0 }), 20)).toBeNull();
  });

  it('choiceOptions: the insane word stays only while no wrong key has emptied the meter', () => {
    const d = returnData({ power: 4, choice: { options: [...CHOICE, INSANE_WORD].map(opt), targets: [], m: 1 } });
    const t = createTurn(d);
    expect(choiceOptions(t, t.data as typeof d, 400).map((o) => o.word)).toEqual([...CHOICE, INSANE_WORD]);
    t.log = [bad(150)];
    expect(choiceOptions(t, t.data as typeof d, 400).map((o) => o.word)).toEqual(CHOICE);
  });
});
