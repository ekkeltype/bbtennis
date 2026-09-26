import { describe, expect, it } from 'vitest';
import { CpuBrain, cpuProfile } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import {
  HUMAN_CHASE_REACTION_MS,
  humanProfile,
  humanTypist,
  simulateMatch,
  simulatePoints,
  summarize,
  type PointRecord,
  type SimTypist,
} from '../../src/core/sim';
import { nextDeadline } from '../../src/core/turn';
import type { Look, MatchConfig, PlayerId, PlayerInfo, ServeTurnData } from '../../src/core/types';

const CONFIG: MatchConfig = {
  format: 'short',
  pace: 'normal',
  surface: 'hard',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: null,
};

const config = (over: Partial<MatchConfig> = {}): MatchConfig => ({ ...CONFIG, ...over });

const HUMAN_50 = humanTypist(50);

const LOOK: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'A', look: LOOK, kind: 'cpu', cpuLevel: null },
  { name: 'B', look: LOOK, kind: 'cpu', cpuLevel: null },
];

/**
 * The serve word option (0 easy, 1 medium, 2 hard) that a human-model server at `wpm` locks on
 * the first point's serve number `serveNo` of match `seed` at Relaxed pace. For a second serve the
 * first one is left to run out the serve clock (a time-violation fault).
 */
function humanServeLock(seed: number, wpm: number, serveNo: 1 | 2): number {
  const engine = new Engine({ config: config({ pace: 'relaxed' }), players: PLAYERS, seed });
  const server = engine.owner();
  if (server === null) throw new Error('no server');
  const brain = new CpuBrain(server, humanProfile(wpm), seed);
  engine.start(server);
  if (serveNo === 2) {
    const first = engine.state.turn?.data.turnId;
    for (let t = engine.state.turn; t !== null && t.data.turnId === first; t = engine.state.turn) {
      const deadline = nextDeadline(t);
      if (deadline === null) throw new Error('first serve stalled');
      engine.clock(server, deadline);
    }
    engine.start(server);
  }
  const data = engine.state.turn?.data as ServeTurnData;
  expect([data.kind, data.serveNo]).toEqual(['serve', serveNo]);
  for (let calls = 0; calls < 10; calls++) {
    const t = engine.state.turn;
    if (t === null) break;
    const prompt = t.active === null ? undefined : t.prompts[t.active];
    if (prompt?.kind === 'serve' && prompt.locked !== null) return prompt.locked;
    const key = brain.plan(t)[0];
    const deadline = nextDeadline(t);
    if (key !== undefined && (deadline === null || key.τ <= deadline)) engine.input(server, key.key, key.τ);
    else if (deadline !== null) engine.clock(server, deadline);
  }
  throw new Error('the server never locked a serve word');
}

/** A record with defaults for the fields a summarize test does not care about. */
function rec(over: Partial<PointRecord> = {}): PointRecord {
  return { shots: 3, ms: 10000, reason: 'winner', serverWon: true, winner: 0, ...over };
}

/**
 * Throws unless the record is self-consistent: an ace is the serve alone and won by the server, a
 * double fault has no shot in play, a winner is won by the last striker and an OUT/NET is lost by
 * the last striker (strike k is the server's when k is odd).
 */
function expectConsistent(p: PointRecord): void {
  expect(Number.isInteger(p.shots) && p.shots >= 0).toBe(true);
  expect(Number.isFinite(p.ms) && p.ms > 0).toBe(true);
  expect([0, 1]).toContain(p.winner);
  const lastStrikeByServer = p.shots % 2 === 1;
  switch (p.reason) {
    case 'ace':
      expect([p.shots, p.serverWon]).toEqual([1, true]);
      break;
    case 'doubleFault':
      expect([p.shots, p.serverWon]).toEqual([0, false]);
      break;
    case 'winner':
      expect(p.serverWon).toBe(lastStrikeByServer);
      break;
    case 'out':
    case 'net':
      expect(p.shots).toBeGreaterThanOrEqual(2);
      expect(p.serverWon).toBe(!lastStrikeByServer);
      break;
    default:
      throw new Error(`unexpected point reason ${p.reason}`);
  }
}

describe('humanProfile (spec §6 human model)', () => {
  it('uses the end points of the model at 25 and 120 WPM, with aggression 2.5 (1 even after the second-serve × 0.4)', () => {
    expect(humanProfile(25)).toEqual({ wpm: 25, err: 0.07, reactionMs: 900, aggression: 2.5 });
    const fast = humanProfile(120);
    expect(fast.wpm).toBe(120);
    expect(fast.err).toBeCloseTo(0.015, 12);
    expect(fast.reactionMs).toBeCloseTo(400, 9);
    expect(fast.aggression).toBe(2.5);
  });

  it('interpolates error rate and reaction linearly in WPM between 25 and 120', () => {
    const mid = humanProfile(72.5);
    expect(mid.err).toBeCloseTo(0.0425, 12);
    expect(mid.reactionMs).toBeCloseTo(650, 9);
    const p50 = humanProfile(50);
    expect(p50.err).toBeCloseTo(0.07 - (25 / 95) * 0.055, 12);
    expect(p50.reactionMs).toBeCloseTo(900 - (25 / 95) * 500, 9);
  });

  it('holds error rate and reaction at the end points outside 25–120 WPM but keeps the speed', () => {
    expect(humanProfile(15)).toEqual({ wpm: 15, err: 0.07, reactionMs: 900, aggression: 2.5 });
    const expert = humanProfile(160);
    expect(expert.wpm).toBe(160);
    expect(expert.err).toBeCloseTo(0.015, 12);
    expect(expert.reactionMs).toBeCloseTo(400, 9);
  });

  it('rejects a speed that is not a finite positive number', () => {
    for (const wpm of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => humanProfile(wpm)).toThrow(RangeError);
    }
  });
});

describe('the human model\'s serve choice (spec §6: the hardest option that fits)', () => {
  // A 120 WPM typist at Relaxed pace fits even a 14-letter serve word (about 1.9 s) in the toss
  // window, so the hardest option that fits is always the hard one.
  const locks = (serveNo: 1 | 2): number[] => Array.from({ length: 40 }, (_, seed) => humanServeLock(seed, 120, serveNo));

  it('takes the hard word on every first serve when every word fits', () => {
    expect(locks(1)).toEqual(Array<number>(40).fill(2));
  });

  it('takes the hard word on every second serve too (the CPU\'s second-serve caution of spec §3.8 does not apply)', () => {
    expect(locks(2)).toEqual(Array<number>(40).fill(2));
  });
});

describe('humanTypist', () => {
  it('is the human profile with the 250 ms chase reaction and the adaptive policy by default', () => {
    expect(HUMAN_CHASE_REACTION_MS).toBe(250);
    expect(humanTypist(70)).toEqual({ profile: humanProfile(70), chaseReactionMs: 250, policy: 'adaptive' });
    expect(humanTypist(70, 'neverHard').policy).toBe('neverHard');
  });
});

describe('summarize', () => {
  it('takes the median and nearest-rank 90th percentile of rally length, and the longest rally', () => {
    const points = [0, 1, 2, 3, 4, 5, 6, 7, 8, 40].map((shots) => rec({ shots }));
    const s = summarize(points);
    expect(s.medianShots).toBe(4.5);
    expect(s.p90Shots).toBe(8);
    expect(s.maxShots).toBe(40);
  });

  it('uses the middle value for an odd count, whatever the input order', () => {
    const s = summarize([7, 1, 3].map((shots) => rec({ shots })));
    expect(s.medianShots).toBe(3);
    expect(s.p90Shots).toBe(7);
  });

  it('gives the share of points that were aces, double faults and won by the server', () => {
    const points = [
      rec({ reason: 'ace', shots: 1, serverWon: true }),
      rec({ reason: 'doubleFault', shots: 0, serverWon: false }),
      rec({ reason: 'winner', serverWon: true }),
      rec({ reason: 'out', serverWon: false }),
    ];
    const s = summarize(points);
    expect(s.aceRate).toBe(0.25);
    expect(s.dfRate).toBe(0.25);
    expect(s.serverWinRate).toBe(0.5);
  });

  it('gives the median point duration in seconds', () => {
    const s = summarize([rec({ ms: 9000 }), rec({ ms: 30000 }), rec({ ms: 12500 })]);
    expect(s.medianSecPerPoint).toBe(12.5);
  });

  it('rejects an empty list instead of returning NaN', () => {
    expect(() => summarize([])).toThrow(RangeError);
  });
});

describe('simulatePoints', () => {
  it('returns exactly the number of points asked for, across as many matches as needed', () => {
    const points = simulatePoints({ config: config({ format: 'tiebreak' }), typists: [HUMAN_50, HUMAN_50], seed: 7, points: 60 });
    expect(points).toHaveLength(60);
  });

  it('records self-consistent points: shots, duration, reason, winner and whether the server won', () => {
    const points = simulatePoints({ config: CONFIG, typists: [HUMAN_50, HUMAN_50], seed: 11, points: 150 });
    points.forEach(expectConsistent);
    const reasons = new Set(points.map((p) => p.reason));
    expect(reasons.has('winner')).toBe(true);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const run = (seed: number): PointRecord[] => simulatePoints({ config: CONFIG, typists: [HUMAN_50, HUMAN_50], seed, points: 40 });
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it('never stalls or produces NaN with extreme typists (15 and 160 WPM)', () => {
    const points = simulatePoints({ config: CONFIG, typists: [humanTypist(15), humanTypist(160)], seed: 5, points: 80 });
    expect(points).toHaveLength(80);
    points.forEach(expectConsistent);
  });

  it("passes each typist's policy to its brain: a 25 WPM 'alwaysHard' server can never serve before the ball drops at Lightning pace", () => {
    const hard: SimTypist = { profile: cpuProfile(0), policy: 'alwaysHard' };
    const points = simulatePoints({ config: config({ pace: 'lightning' }), typists: [hard, HUMAN_50], seed: 2, points: 60 });
    const served = points.filter((p) => serverOf(p) === 0);
    expect(served.length).toBeGreaterThan(10);
    for (const p of served) expect(p.reason).toBe('doubleFault');
  });

  it("passes each typist's chase reaction to its brain: a receiver who waits a minute is aced by every serve that lands", () => {
    const asleep: SimTypist = { profile: humanProfile(50), chaseReactionMs: 60000 };
    const points = simulatePoints({ config: CONFIG, typists: [HUMAN_50, asleep], seed: 9, points: 60 });
    const received = points.filter((p) => serverOf(p) === 0);
    expect(received.length).toBeGreaterThan(10);
    for (const p of received) expect(['ace', 'doubleFault']).toContain(p.reason);
    expect(received.some((p) => p.reason === 'ace')).toBe(true);
  });
});

describe('simulateMatch', () => {
  it('plays one tiebreak to its end: the winner reaches 7 points with a 2-point lead', () => {
    const { winner, points } = simulateMatch({ config: config({ format: 'tiebreak' }), typists: [HUMAN_50, HUMAN_50], seed: 21 });
    const won = [0, 1].map((p) => points.filter((r) => r.winner === p).length);
    const w = won[winner] ?? 0;
    const l = won[1 - winner] ?? 0;
    expect(w).toBeGreaterThanOrEqual(7);
    expect(w - l).toBeGreaterThanOrEqual(2);
    expect(points[points.length - 1]?.winner).toBe(winner);
    points.forEach(expectConsistent);
  });

  it('is won by a black belt 3rd dan against a white belt', () => {
    const typists: [SimTypist, SimTypist] = [{ profile: cpuProfile(0) }, { profile: cpuProfile(14) }];
    expect(simulateMatch({ config: CONFIG, typists, seed: 1 }).winner).toBe(1);
  });
});

/** The server of a point, from who won it and whether the server did. */
function serverOf(p: PointRecord): PlayerId {
  return p.serverWon ? p.winner : p.winner === 0 ? 1 : 0;
}
