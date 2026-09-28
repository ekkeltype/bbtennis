import { describe, expect, it } from 'vitest';
import { receiverSpot, restSpot, serverSpot } from '../../src/core/court';
import { createScore } from '../../src/core/scoring';
import { stanceFor } from '../../src/core/trajectory';
import { createTurn, startTurn, turnClock, turnInput } from '../../src/core/turn';
import { TUNING } from '../../src/core/tuning';
import {
  other,
  type BallFlight,
  type Look,
  type MatchState,
  type PlayerId,
  type PlayerStats,
  type Side,
  type TurnState,
  type Vec2,
  type ViewModel,
} from '../../src/core/types';
import { dist2 } from '../../src/core/util';
import { PlayerAnimator, type PlayerPose } from '../../src/render/players';
import { ANIMS } from '../../src/render/sprites/animations';
import { flight, opt, returnData, serveData, serveSet } from '../core/turnFixtures';

const LOOK: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const STATS: PlayerStats = {
  pointsWon: 0, aces: 0, doubleFaults: 0, winners: 0, errors: 0, wordsCompleted: 0,
  intervalSum: 0, typingMs: 0, topWpm: 0, correctKeys: 0, wrongKeys: 0, fastestServeKmh: 0,
};

function matchState(turn: TurnState | null, lastTurn: TurnState | null = null, over: Partial<MatchState> = {}): MatchState {
  return {
    v: 2,
    config: { format: 'short', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: [
      { name: 'Alex', look: LOOK, kind: 'human', cpuLevel: null },
      { name: 'Kai', look: LOOK, kind: 'cpu', cpuLevel: 3 },
    ],
    score: createScore('short', 'advantage', 0),
    stats: [{ ...STATS }, { ...STATS }],
    turn,
    lastTurn,
    rallyStrikes: 0,
    longestRally: 0,
    power: [0, 0],
    pointNo: 1,
    status: 'playing',
    winner: null,
    forfeitBy: null,
    nextTurnId: 20,
    nextPromptBase: 100,
    rng: null,
    picker: null,
    ...over,
  };
}

function view(pub: MatchState, turnτ: number, viewer: PlayerId | 'spectator' = 0): ViewModel {
  return {
    pub,
    viewer,
    turnτ,
    liveTurn: null,
    early: null,
    events: [],
    overlay: {
      paused: false, countdown: null, coach: null, wait: false, unstable: false,
      hintSpace: false, hintFirstLetter: false, focusLost: false, rttMs: null,
    },
  };
}

/** A serve turn of `server` from `side`, clocked into PRE_SERVE (lead-in 2.5 s). */
function preServeTurn(server: PlayerId = 0, side: Side = 'deuce'): TurnState {
  const receiver = other(server);
  const t = createTurn(serveData({ owner: server, receiver, side, wordSets: [serveSet(['cat', 'garden', 'watermelons'], 'T', receiver, side)] }));
  startTurn(t);
  turnClock(t, 2600);
  return t;
}

/** A rally ball from player 0 (near the server's spot) to player 1 landing at `landing`. */
const incoming = (landing: Vec2): BallFlight => flight({ p0: { x: 0.8, y: -12, z: 1 }, landing });

/** Keys of `word` typed from `from` ms, `gap` ms apart. */
const typed = (word: string, from: number, gap: number): { τ: number; key: string }[] =>
  [...word].map((key, i) => ({ τ: from + i * gap, key }));

/**
 * Plays a return turn frame by frame (dt ms) after a PRE_SERVE frame that puts both players on their
 * serve/receive spots; feeds `keys` when the clock passes them. Returns every frame's poses.
 */
function playReturn(
  f: BallFlight,
  keys: { τ: number; key: string }[],
  untilτ: number,
  dt: number,
  a = new PlayerAnimator(),
): { poses: [PlayerPose, PlayerPose][]; turn: TurnState; τs: number[] } {
  const serve = preServeTurn();
  a.update(view(matchState(serve), 2600), 16);
  const t = createTurn(returnData({ incoming: f, chase: opt('garden'), isServeReturn: false }));
  startTurn(t);
  const poses: [PlayerPose, PlayerPose][] = [];
  const τs: number[] = [];
  let next = 0;
  for (let τ = 0; τ <= untilτ; τ += dt) {
    while (next < keys.length && keys[next]!.τ <= τ) {
      turnInput(t, keys[next]!.key, keys[next]!.τ);
      next++;
    }
    turnClock(t, τ);
    poses.push(a.update(view(matchState(t, serve), τ), dt));
    τs.push(τ);
  }
  return { poses, turn: t, τs };
}

const WIDE = incoming({ x: 2.5, y: 9 });

describe('PlayerAnimator', () => {
  it('puts the server and the receiver on their spots in PRE_SERVE, for both servers and sides', () => {
    for (const server of [0, 1] as const) {
      for (const side of ['deuce', 'ad'] as const) {
        const poses = new PlayerAnimator().update(view(matchState(preServeTurn(server, side)), 2600), 16);
        const receiver = other(server);
        expect(poses[server].feet.x).toBeCloseTo(serverSpot(server, side).x, 9);
        expect(poses[server].feet.y).toBeCloseTo(serverSpot(server, side).y, 9);
        expect(poses[receiver].feet.x).toBeCloseTo(receiverSpot(receiver, side).x, 9);
        expect(poses[receiver].feet.y).toBeCloseTo(receiverSpot(receiver, side).y, 9);
      }
    }
  });

  it('brings players back to their spots when PRE_SERVE begins after a rally', () => {
    const a = new PlayerAnimator();
    playReturn(WIDE, typed('garden', 50, 60), 1500, 16, a);
    const poses = a.update(view(matchState(preServeTurn(1, 'ad')), 2600), 16);
    expect(dist2(poses[1].feet, serverSpot(1, 'ad'))).toBeLessThan(1e-9);
    expect(dist2(poses[0].feet, receiverSpot(0, 'ad'))).toBeLessThan(1e-9);
  });

  it('shows the viewer from behind (near) and the opponent from the front (far); spectators watch from end 0', () => {
    const pub = matchState(preServeTurn());
    expect(new PlayerAnimator().update(view(pub, 2600, 0), 16).map((p) => p.view)).toEqual(['near', 'far']);
    expect(new PlayerAnimator().update(view(pub, 2600, 1), 16).map((p) => p.view)).toEqual(['far', 'near']);
    expect(new PlayerAnimator().update(view(pub, 2600, 'spectator'), 16).map((p) => p.view)).toEqual(['near', 'far']);
  });

  it('moves the receiver monotonically toward the stance as the chase word is typed, and reaches it', () => {
    const { poses } = playReturn(WIDE, typed('garden', 300, 200), 2600, 16);
    const stance = stanceFor(WIDE.contact, 1, receiverSpot(1, 'deuce')).feet;
    let prev = Infinity;
    const gaps = poses.map((p) => dist2(p[1].feet, stance));
    for (const d of gaps) {
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
    expect(gaps[0]).toBeGreaterThan(4);
    expect(prev).toBeLessThan(1e-6);
  });

  it('keeps the receiver at the start until the first chase key and part-way while the word is half typed', () => {
    const { poses, τs } = playReturn(WIDE, typed('gar', 400, 100), 1800, 16);
    const start = receiverSpot(1, 'deuce');
    const stance = stanceFor(WIDE.contact, 1, start).feet;
    const before = poses[τs.findIndex((τ) => τ >= 384)]!;
    expect(dist2(before[1].feet, start)).toBeLessThan(1e-9);
    const settled = poses[poses.length - 1]!;
    // Half the word typed: easeOutQuad(0.5) = 0.75 of the way to the stance.
    const target = { x: start.x + (stance.x - start.x) * 0.75, y: start.y + (stance.y - start.y) * 0.75 };
    expect(dist2(settled[1].feet, target)).toBeLessThan(1e-6);
  });

  it('never moves a player faster than 7 m/s while chasing, nor the striker faster than 4 m/s while jogging back', () => {
    for (const dt of [8, 16, 33, 100]) {
      const { poses } = playReturn(WIDE, typed('garden', 40, 10), 2400, dt);
      for (let i = 1; i < poses.length; i++) {
        const receiver = dist2(poses[i]![1].feet, poses[i - 1]![1].feet);
        const striker = dist2(poses[i]![0].feet, poses[i - 1]![0].feet);
        expect(receiver).toBeLessThanOrEqual((7 * dt) / 1000 + 1e-9);
        expect(striker).toBeLessThanOrEqual((4 * dt) / 1000 + 1e-9);
      }
      const receiverSteps = poses.slice(1).map((p, i) => dist2(p[1].feet, poses[i]![1].feet));
      expect(Math.max(...receiverSteps)).toBeGreaterThan((6.9 * dt) / 1000);
    }
  });

  it('jogs the striker toward the centre rest spot after the follow-through', () => {
    const { poses } = playReturn(WIDE, [], 2000, 16);
    const last = poses[poses.length - 1]![0];
    expect(dist2(last.feet, restSpot(0))).toBeLessThan(1e-6);
  });

  it('swings the forehand or backhand that stanceFor picks, with the contact frame on the strike', () => {
    for (const f of [incoming({ x: -4, y: 9 }), WIDE]) {
      const stroke = stanceFor(f.contact, 1, receiverSpot(1, 'deuce')).forehand ? 'forehand' : 'backhand';
      const keys = [...typed('garden', 100, 60), ...typed('drop', 600, 60)];
      const { poses, τs, turn } = playReturn(f, keys, f.T, 4);
      expect(turn.outcome?.kind).toBe('strike');
      const swing = poses[τs.findIndex((τ) => τ >= f.T - 60)]![1];
      expect(swing.anim).toBe(stroke);
      expect(swing.frame).toBe(1);
      const contact = poses[poses.length - 1]![1];
      expect(contact.anim).toBe(stroke);
      expect(contact.frame).toBe(2);
    }
    expect(stanceFor(incoming({ x: -4, y: 9 }).contact, 1, receiverSpot(1, 'deuce')).forehand).toBe(true);
    expect(stanceFor(WIDE.contact, 1, receiverSpot(1, 'deuce')).forehand).toBe(false);
  });

  it('follows through in the next turn after its own strike, then runs back', () => {
    const f = incoming({ x: -4, y: 9 });
    const a = new PlayerAnimator();
    const keys = [...typed('garden', 100, 60), ...typed('drop', 600, 60)];
    const { turn } = playReturn(f, keys, f.T, 4, a);
    const strike = turn.outcome?.kind === 'strike' ? turn.outcome.strike : null;
    expect(strike).not.toBeNull();
    const next = createTurn(
      returnData({ turnId: 9, owner: 0, striker: 1, incoming: strike!.flight, chase: opt('drop'), isServeReturn: false }),
    );
    startTurn(next);
    const at = (τ: number): PlayerPose => {
      turnClock(next, τ);
      return a.update(view(matchState(next, turn), τ), 16)[1];
    };
    expect(at(0)).toMatchObject({ anim: 'forehand', frame: 2 });
    expect(at(100)).toMatchObject({ anim: 'forehand', frame: 3 });
    expect(at(1200).anim).not.toBe('forehand');
  });

  it('celebrates the point winner and hangs the loser\'s head during a point lead-in', () => {
    // Player 1 never reaches the ball: player 0 wins with a winner.
    const miss = createTurn(returnData({ incoming: WIDE }));
    startTurn(miss);
    turnClock(miss, WIDE.T + WIDE.grace);
    expect(miss.outcome?.kind).toBe('miss');
    // Player 0 hits OUT: player 1 wins the point.
    const out = createTurn(returnData({ incoming: flight({ landing: { x: 4.6, y: 9 }, outcome: 'out' }) }));
    startTurn(out);
    turnClock(out, 5000);
    expect(out.outcome?.kind).toBe('call');

    for (const [last, winner] of [[miss, 0], [out, 1]] as const) {
      const next = createTurn(serveData({ leadIn: { kind: 'point', ms: 2000, text: ['WINNER'] } }));
      startTurn(next);
      turnClock(next, 800);
      const poses = new PlayerAnimator().update(view(matchState(next, last), 800), 16);
      expect(poses[winner].anim).toBe('celebrate');
      expect(poses[other(winner)].anim).toBe('dejected');
    }
  });

  it('starts celebrating a double fault only when its point call follows the FAULT call (R30)', () => {
    // The second serve runs out of time: player 1 wins the point on a double fault.
    const fault = createTurn(serveData({ serveNo: 2 }));
    startTurn(fault);
    turnClock(fault, 2500 + 30000 + 16);
    expect(fault.outcome).toMatchObject({ kind: 'fault', reason: 'timeViolation' });
    const { faultMs, pointMs } = TUNING.leadIn;
    const next = createTurn(
      serveData({ turnId: 9, leadIn: { kind: 'point', ms: faultMs + pointMs, text: ['FAULT', 'TIME VIOLATION', 'DOUBLE FAULT'] } }),
    );
    startTurn(next);
    const a = new PlayerAnimator();
    const at = (τ: number): [PlayerPose, PlayerPose] => a.update(view(matchState(next, fault), τ), 16);
    for (let τ = 0; τ < faultMs; τ += 16) {
      const poses = at(τ);
      expect(poses.map((p) => p.anim)).not.toContain('celebrate');
      expect(poses.map((p) => p.anim)).not.toContain('dejected');
    }
    const start = at(faultMs + 10);
    expect(start[1]).toMatchObject({ anim: 'celebrate', frame: 0 });
    expect(start[0]).toMatchObject({ anim: 'dejected', frame: 0 });
    expect(at(faultMs + ANIMS.celebrate.msPerFrame + 10)[1]).toMatchObject({ anim: 'celebrate', frame: 1 });
  });

  it('celebrates the match winner once the match is over', () => {
    const last = createTurn(returnData({ incoming: WIDE }));
    startTurn(last);
    turnClock(last, WIDE.T + WIDE.grace);
    const pub = matchState(null, last, { status: 'over', winner: 0 });
    const poses = new PlayerAnimator().update(view(pub, 0), 16);
    expect(poses[0].anim).toBe('celebrate');
    expect(poses[1].anim).toBe('dejected');
  });

  it('holds the serve toss then trophy pose while the ball is in the air', () => {
    const t = preServeTurn();
    turnInput(t, 'toss', 3000);
    const a = new PlayerAnimator();
    const at = (τ: number): PlayerPose => {
      turnClock(t, τ);
      return a.update(view(matchState(t), τ), 16)[0];
    };
    expect(at(2800).anim).toBe('idle');
    expect(at(3100)).toMatchObject({ anim: 'serve', frame: 0 });
    expect(at(4600)).toMatchObject({ anim: 'serve', frame: 1 });
  });
});
