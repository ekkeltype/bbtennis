import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioDirector } from '../../src/audio/director';
import type { DirectorContext } from '../../src/audio/director';
import type { AudioEngine, PlayOptions, SfxName } from '../../src/audio/engine';
import type { Umpire } from '../../src/audio/speech';
import { umpireCall } from '../../src/core/scoring';
import type { GameEvent, PlayerId, PublicState, Surface, Tier } from '../../src/core/types';

vi.mock('../../src/core/scoring', () => ({
  umpireCall: vi.fn((_score: unknown, names: [string, string], winner: PlayerId) => `SCORE ${names[winner]}`),
}));

/** Records what the director asks the engine for. */
class FakeEngine {
  readonly plays: { name: SfxName; opts: PlayOptions | undefined }[] = [];
  readonly crowdLevels: number[] = [];

  play(name: SfxName, opts?: PlayOptions): void {
    this.plays.push({ name, opts });
  }

  crowd(level: number): void {
    this.crowdLevels.push(level);
  }

  names(): SfxName[] {
    return this.plays.map((p) => p.name);
  }
}

class FakeUmpire {
  readonly said: { text: string; age: number }[] = [];

  say(text: string, eventAgeMs: number): void {
    this.said.push({ text, age: eventAgeMs });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A GameEvent without its (turn, τ) stamp. */
type EventBody = DistributiveOmit<GameEvent, 'turn' | 'τ'>;

const CURRENT_TURN = 7;

function ev(body: EventBody, τ = 1000, turn = CURRENT_TURN): GameEvent {
  return { turn, τ, ...body } as GameEvent;
}

/** The slice of PublicState the director reads (score for umpireCall, names, turn clocks for event age). */
function stateAt(opts: { τ: number; last?: { turnId: number; τ: number } }): PublicState {
  return {
    players: [{ name: 'Alex' }, { name: 'Bo' }],
    score: { points: [1, 0] },
    turn: { data: { turnId: CURRENT_TURN }, τ: opts.τ },
    lastTurn: opts.last ? { data: { turnId: opts.last.turnId }, τ: opts.last.τ } : null,
  } as unknown as PublicState;
}

let engine: FakeEngine;
let umpire: FakeUmpire;
let director: AudioDirector;

function context(over: Partial<DirectorContext> = {}): DirectorContext {
  return { viewer: 0, muted: false, state: stateAt({ τ: 1000 }), surface: 'hard', ...over };
}

beforeEach(() => {
  engine = new FakeEngine();
  umpire = new FakeUmpire();
  director = new AudioDirector(engine as unknown as AudioEngine, umpire as unknown as Umpire);
  vi.mocked(umpireCall).mockClear();
});

const strike = (tier: Tier): EventBody => ({
  type: 'strike',
  player: 1,
  word: 'ball',
  tier,
  kmh: 120,
  isServe: false,
  stretch: false,
  forehand: true,
});

describe('AudioDirector ball sounds', () => {
  it('plays a racket hit per strike, the hard-tier shot as hitHard', () => {
    director.onEvents([ev(strike('easy')), ev(strike('medium')), ev(strike('hard'))], context());
    expect(engine.names()).toEqual(['hit', 'hit', 'hitHard']);
  });

  it.each<Surface>(['hard', 'clay', 'grass', 'dojo'])('plays the bounce with the court surface (%s)', (surface) => {
    director.onEvents([ev({ type: 'bounce', at: { x: 0, y: 5 }, inCourt: true })], context({ surface }));
    expect(engine.plays).toEqual([{ name: 'bounce', opts: { surface, pan: 0 } }]);
  });

  it('pans a bounce toward its side of the court as the viewer sees it', () => {
    const bounceRight: EventBody = { type: 'bounce', at: { x: 4, y: -3 }, inCourt: true };
    director.onEvents([ev(bounceRight)], context({ viewer: 0 }));
    director.onEvents([ev(bounceRight)], context({ viewer: 1 }));
    director.onEvents([ev({ type: 'bounce', at: { x: 40, y: 0 }, inCourt: false })], context({ viewer: 0 }));
    const pans = engine.plays.map((p) => p.opts?.pan ?? 0);
    expect(pans[0]).toBeGreaterThan(0);
    expect(pans[1]).toBeCloseTo(-(pans[0] ?? 0), 10);
    expect(pans[2]).toBe(1);
  });

  it('plays the net cord and the coin toss', () => {
    director.onEvents([ev({ type: 'coinToss', winner: 0 }), ev({ type: 'netHit' })], context());
    expect(engine.names()).toEqual(['coin', 'netHit']);
  });
});

describe('AudioDirector crowd', () => {
  it('applauds a point won by the viewer, whatever the reason', () => {
    director.onEvents([ev({ type: 'point', winner: 0, reason: 'out' })], context({ viewer: 0 }));
    director.onEvents([ev({ type: 'point', winner: 1, reason: 'ace' })], context({ viewer: 1 }));
    expect(engine.plays).toEqual([
      { name: 'applause', opts: undefined },
      { name: 'applause', opts: undefined },
    ]);
  });

  it('applauds every point for a spectator', () => {
    director.onEvents([ev({ type: 'point', winner: 1, reason: 'net' })], context({ viewer: 'spectator' }));
    expect(engine.names()).toEqual(['applause']);
  });

  it("goes 'ooh' at the viewer's errors and applauds the opponent's aces and winners politely", () => {
    const lost = (reason: 'out' | 'net' | 'doubleFault' | 'ace' | 'winner'): GameEvent =>
      ev({ type: 'point', winner: 1, reason });
    for (const reason of ['out', 'net', 'doubleFault'] as const) director.onEvents([lost(reason)], context());
    expect(engine.names()).toEqual(['ooh', 'ooh', 'ooh']);
    director.onEvents([lost('ace')], context());
    director.onEvents([lost('winner')], context());
    const polite = engine.plays.slice(3);
    expect(polite.map((p) => p.name)).toEqual(['applause', 'applause']);
    for (const p of polite) expect(p.opts?.gain).toBeLessThan(1);
  });

  it('hushes the murmur for the serve and lets it buzz after a point', () => {
    director.onEvents([ev({ type: 'coinToss', winner: 1 })], context());
    director.onEvents([ev({ type: 'preServe', server: 1, serveNo: 1, side: 'deuce' })], context());
    director.onEvents([ev({ type: 'point', winner: 0, reason: 'winner' })], context());
    const [chatter, hush, buzz] = engine.crowdLevels;
    expect(engine.crowdLevels).toHaveLength(3);
    expect(hush).toBeGreaterThan(0);
    expect(hush).toBeLessThan(chatter ?? 0);
    expect(buzz).toBeGreaterThan(hush ?? 1);
  });

  it('makes no sound for a forfeit', () => {
    director.onEvents([ev({ type: 'point', winner: 0, reason: 'forfeit' })], context());
    expect(engine.plays).toEqual([]);
    expect(umpire.said).toEqual([]);
  });
});

describe('AudioDirector typing sounds', () => {
  it("clicks quieter for the opponent's keystrokes", () => {
    director.onEvents(
      [
        ev({ type: 'lock', player: 1, prompt: 3, option: 0 }),
        ev({ type: 'keyOk', player: 1, prompt: 3 }),
        ev({ type: 'keyBad', player: 1, prompt: 3 }),
      ],
      context({ viewer: 0 }),
    );
    expect(engine.names()).toEqual(['key', 'key', 'key']);
    for (const p of engine.plays) {
      expect(p.opts?.gain).toBeGreaterThan(0);
      expect(p.opts?.gain).toBeLessThan(1);
    }
  });

  it("ignores the viewer's own typing events (those sound through onLocalKey)", () => {
    director.onEvents(
      [
        ev({ type: 'lock', player: 0, prompt: 3, option: 1 }),
        ev({ type: 'keyOk', player: 0, prompt: 3 }),
        ev({ type: 'keyBad', player: 0, prompt: 3 }),
        ev({ type: 'wordDone', player: 0, prompt: 3, wpm: 60 }),
      ],
      context({ viewer: 0 }),
    );
    expect(engine.plays).toEqual([]);
  });

  it('maps local key results to click, buzz, lock tick and word chime', () => {
    director.onLocalKey('ignored');
    director.onLocalKey('locked');
    director.onLocalKey('correct');
    director.onLocalKey('wrong');
    director.onLocalKey('completed');
    expect(engine.plays).toEqual([
      { name: 'lock', opts: undefined },
      { name: 'key', opts: undefined },
      { name: 'bad', opts: undefined },
      { name: 'done', opts: undefined },
    ]);
  });

  it('ticks when the viewer becomes the active typist (own serve or own chase word)', () => {
    director.onEvents([ev({ type: 'preServe', server: 0, serveNo: 1, side: 'ad' })], context({ viewer: 0 }));
    director.onEvents([ev({ type: 'promptShown', player: 0, prompt: 9, kind: 'chase' })], context({ viewer: 0 }));
    expect(engine.names()).toEqual(['yourTurn', 'yourTurn']);
  });

  it("does not tick for the opponent's turn or the viewer's own choice prompt", () => {
    director.onEvents([ev({ type: 'preServe', server: 1, serveNo: 2, side: 'ad' })], context({ viewer: 0 }));
    director.onEvents([ev({ type: 'promptShown', player: 1, prompt: 9, kind: 'chase' })], context({ viewer: 0 }));
    director.onEvents([ev({ type: 'promptShown', player: 0, prompt: 10, kind: 'choice' })], context({ viewer: 0 }));
    expect(engine.names()).toEqual([]);
  });
});

describe('AudioDirector umpire', () => {
  it('announces the score after a point using umpireCall on the current score and names', () => {
    const ctx = context();
    director.onEvents([ev({ type: 'point', winner: 1, reason: 'winner' })], ctx);
    expect(umpireCall).toHaveBeenCalledWith(ctx.state.score, ['Alex', 'Bo'], 1);
    expect(umpire.said.map((s) => s.text)).toEqual(['SCORE Bo']);
  });

  it('speaks a call and the score as one utterance, so cancel() cannot cut the call off', () => {
    director.onEvents(
      [ev({ type: 'call', call: 'out', player: 1 }), ev({ type: 'point', winner: 0, reason: 'out' })],
      context(),
    );
    expect(umpire.said.map((s) => s.text)).toEqual(['Out. SCORE Alex']);
  });

  it.each([
    ['fault', 'Fault'],
    ['ballDropped', 'Fault'],
    ['timeViolation', 'Time violation'],
    ['doubleFault', 'Double fault'],
    ['out', 'Out'],
  ] as const)('says %s as "%s"', (call, words) => {
    director.onEvents([ev({ type: 'call', call, player: 0 })], context());
    expect(umpire.said.map((s) => s.text)).toEqual([words]);
  });

  it('says only the most important call of a frame', () => {
    director.onEvents(
      [ev({ type: 'call', call: 'out', player: 0 }), ev({ type: 'call', call: 'fault', player: 0 })],
      context(),
    );
    director.onEvents(
      [ev({ type: 'call', call: 'fault', player: 0 }), ev({ type: 'call', call: 'doubleFault', player: 0 })],
      context(),
    );
    expect(umpire.said.map((s) => s.text)).toEqual(['Fault', 'Double fault']);
  });

  it('leaves ace, winner and net calls and situation banners to the score call and the screen', () => {
    director.onEvents(
      [
        ev({ type: 'call', call: 'ace', player: 0 }),
        ev({ type: 'call', call: 'winner', player: 0 }),
        ev({ type: 'call', call: 'net', player: 0 }),
        ev({ type: 'situation', text: 'MATCH POINT' }),
      ],
      context(),
    );
    expect(umpire.said).toEqual([]);
  });

  it("passes the event's age on the turn clocks so the umpire can drop stale calls", () => {
    const fromCurrentTurn = context({ state: stateAt({ τ: 1300 }) });
    director.onEvents([ev({ type: 'call', call: 'fault', player: 0 }, 1000)], fromCurrentTurn);
    const afterTurnEnd = context({ state: stateAt({ τ: 150, last: { turnId: 6, τ: 4200 } }) });
    director.onEvents([ev({ type: 'call', call: 'out', player: 0 }, 4000, 6)], afterTurnEnd);
    const olderTurn = context({ state: stateAt({ τ: 150, last: { turnId: 6, τ: 4200 } }) });
    director.onEvents([ev({ type: 'call', call: 'out', player: 0 }, 4000, 5)], olderTurn);
    expect(umpire.said.map((s) => s.age)).toEqual([300, 350, Number.POSITIVE_INFINITY]);
  });
});

describe('AudioDirector power meter and insane sounds (power-meter spec §6)', () => {
  const power = (player: PlayerId, from: number, to: number): EventBody => ({ type: 'power', player, from, to });

  it('an insane strike hits hard and draws the crowd\'s "ooh"', () => {
    director.onEvents([ev(strike('insane'))], context());
    expect(engine.names()).toEqual(['hitHard', 'ooh']);
  });

  it('plays powerUp when a meter fills and powerDown when a full one empties; other changes are silent', () => {
    director.onEvents([ev(power(0, 3, 4)), ev(power(0, 4, 0)), ev(power(0, 2, 0)), ev(power(0, 1, 2))], context());
    expect(engine.names()).toEqual(['powerUp', 'powerDown']);
  });

  it('plays the opponent\'s meter cues quieter', () => {
    director.onEvents([ev(power(1, 3, 4))], context({ viewer: 0 }));
    expect(engine.plays).toEqual([{ name: 'powerUp', opts: { gain: 0.6 } }]);
  });
});

describe('AudioDirector muted (attract mode)', () => {
  const everything: GameEvent[] = [
    ev({ type: 'coinToss', winner: 0 }),
    ev({ type: 'preServe', server: 0, serveNo: 1, side: 'deuce' }),
    ev(strike('hard')),
    ev({ type: 'bounce', at: { x: 1, y: 2 }, inCourt: true }),
    ev({ type: 'netHit' }),
    ev({ type: 'keyOk', player: 1, prompt: 1 }),
    ev({ type: 'call', call: 'out', player: 1 }),
    ev({ type: 'point', winner: 0, reason: 'out' }),
  ];

  it('plays, says and raises nothing', () => {
    director.onEvents(everything, context({ muted: true }));
    expect(engine.plays).toEqual([]);
    expect(engine.crowdLevels).toEqual([]);
    expect(umpire.said).toEqual([]);
  });

  it('silences a crowd it raised earlier', () => {
    director.onEvents([ev({ type: 'coinToss', winner: 0 })], context());
    director.onEvents(everything, context({ muted: true }));
    director.onEvents(everything, context({ muted: true }));
    expect(engine.crowdLevels.slice(1)).toEqual([0]);
  });
});
