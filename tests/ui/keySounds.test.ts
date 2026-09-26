import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../src/core/types';
import { localKeyResults } from '../../src/ui/keySounds';

const at = { turn: 4, τ: 100 };
const lock = (player: 0 | 1, prompt = 1): GameEvent => ({ ...at, type: 'lock', player, prompt, option: 0 });
const ok = (player: 0 | 1, prompt = 1): GameEvent => ({ ...at, type: 'keyOk', player, prompt });
const bad = (player: 0 | 1, prompt = 1): GameEvent => ({ ...at, type: 'keyBad', player, prompt });
const done = (player: 0 | 1, prompt = 1): GameEvent => ({ ...at, type: 'wordDone', player, prompt, wpm: 50 });

describe('localKeyResults', () => {
  it("maps the viewer's own typing events to key results in order", () => {
    expect(localKeyResults([lock(0), ok(0), bad(0), ok(0)], 0)).toEqual(['locked', 'correct', 'wrong', 'correct']);
  });

  it('a completing key sounds once, as completed', () => {
    expect(localKeyResults([ok(0), ok(0), done(0)], 0)).toEqual(['correct', 'completed']);
    expect(localKeyResults([lock(0, 2), done(0, 2)], 0)).toEqual(['completed']);
  });

  it("ignores the opponent's typing (the director voices it) and other events", () => {
    const events: GameEvent[] = [ok(1), bad(1), done(1), { ...at, type: 'toss', player: 0 }, { ...at, type: 'netHit' }];
    expect(localKeyResults(events, 0)).toEqual([]);
  });

  it('a spectator has no own keys', () => {
    expect(localKeyResults([ok(0), ok(1)], 'spectator')).toEqual([]);
  });
});
