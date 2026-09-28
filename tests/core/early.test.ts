import { describe, expect, it } from 'vitest';
import { EARLY_PROMPT, EarlyChase, withoutEarlyEvents } from '../../src/core/early';
import { createTurn, MAX_EARLY_KEYS, startTurn, turnInput } from '../../src/core/turn';
import type { GameEvent, TurnState } from '../../src/core/types';
import { returnData, serveData } from './turnFixtures';

/** Player 1's return turn (turn 8): its chase 'ball' typed at 100..400, then 'drop' (choice) locked at `lockAt`. */
function locked(lockAt = 600): TurnState {
  const t = createTurn(returnData());
  startTurn(t);
  [...'ball'].forEach((ch, i) => turnInput(t, ch, 100 * (i + 1)));
  turnInput(t, 'd', lockAt);
  return t;
}

const opened = (t: TurnState, τ: number, power: number | null = 0): EarlyChase => {
  const o = EarlyChase.open(t, τ, power);
  if (o === null) throw new Error('expected an early chase');
  return o.chase;
};

describe('EarlyChase (early-typing spec §2)', () => {
  it("opens for the striker's opponent once the choice word is locked, not before", () => {
    const t = locked(600);
    expect(EarlyChase.open(t, 599, 0)).toBeNull();
    const o = EarlyChase.open(t, 600, 0);
    expect(o?.chase).toMatchObject({ player: 0, turnId: 8, lockτ: 600 });
    expect(o?.chase.prompt).toMatchObject({ kind: 'chase', options: [{ word: 'drop' }], locked: 0, shownAt: 600, typed: 0 });
    expect(o?.events).toEqual([{ turn: 8, τ: 600, type: 'promptShown', player: 0, prompt: EARLY_PROMPT, kind: 'chase' }]);
  });

  it('never opens on a serve turn or an unlocked return turn', () => {
    const serve = createTurn(serveData());
    startTurn(serve);
    expect(EarlyChase.open(serve, 1e6, 0)).toBeNull();
    const ret = createTurn(returnData());
    startTurn(ret);
    expect(EarlyChase.open(ret, 1e6, 0)).toBeNull();
  });

  it("types with the chase rules and gives feedback events on the striker's clock", () => {
    const early = opened(locked(), 600, 2);
    expect(early.press('d', 900)).toEqual([{ turn: 8, τ: 900, type: 'keyOk', player: 0, prompt: EARLY_PROMPT }]);
    expect(early.press('x', 1000).map((e) => e.type)).toEqual(['keyBad', 'power']);
    expect(early.press('y', 1050).map((e) => e.type)).toEqual(['keyBad']); // the meter is empty already
    early.press('r', 1100);
    early.press('o', 1200);
    expect(early.press('p', 1300).map((e) => e.type)).toEqual(['keyOk', 'wordDone']);
    expect(early.prompt).toMatchObject({ typed: 4, wrongKeys: 2, slips: 1, completedAt: 1300 });
  });

  it('ignores keys once the word is complete and after MAX_EARLY_KEYS keys', () => {
    const done = opened(locked(), 600);
    [...'drop'].forEach((ch, i) => done.press(ch, 700 + i));
    expect(done.press('d', 800)).toEqual([]);
    expect(done.count).toBe(4);
    const mash = opened(locked(), 600);
    mash.press('d', 700);
    for (let i = 0; i < 100; i++) mash.press('z', 701 + i);
    expect(mash.count).toBe(MAX_EARLY_KEYS);
    expect(mash.prompt.completedAt).toBeNull();
  });

  it('keeps its keys in time order and never before the lock', () => {
    const early = opened(locked(600), 600);
    early.press('d', 500);
    early.press('r', 450);
    expect(early.keysAt(2000)).toEqual([{ key: 'd', τ: -1400 }, { key: 'r', τ: -1400 }]);
  });

  it("re-bases its keys to the receiver's clock for a strike, leaving out keys after it", () => {
    const early = opened(locked(600), 600);
    early.press('d', 700);
    early.press('r', 800);
    early.press('o', 950);
    expect(early.keysAt(900)).toEqual([{ key: 'd', τ: -200 }, { key: 'r', τ: -100 }]);
  });
});

describe('withoutEarlyEvents', () => {
  it('drops events stamped before τ 0 and keeps the rest in order', () => {
    const ev = (τ: number): GameEvent => ({ turn: 1, τ, type: 'keyOk', player: 0, prompt: 1 });
    expect(withoutEarlyEvents([ev(-5), ev(0), ev(-1), ev(3)])).toEqual([ev(0), ev(3)]);
  });
});
