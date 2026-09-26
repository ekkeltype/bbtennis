import { describe, expect, it } from 'vitest';
import { cpuProfile, type CpuProfile } from '../../src/core/cpu';
import { serveTargets } from '../../src/core/court';
import { Engine, accuracy, averageWpm, emptyStats } from '../../src/core/engine';
import { redact } from '../../src/core/redact';
import { seedRng, uniform } from '../../src/core/rng';
import { TUNING } from '../../src/core/tuning';
import {
  other,
  type GameEvent,
  type MatchConfig,
  type MatchState,
  type PlayerId,
  type PlayerInfo,
  type PromptKind,
  type PromptState,
  type ServeTurnData,
  type TrainingFlags,
  type TurnState,
} from '../../src/core/types';
import { wordCps, wpmOf } from '../../src/core/typing';
import { initialsOk } from '../../src/core/words/picker';
import {
  CONFIG,
  Driver,
  PLAYERS,
  apply,
  assertJsonSafe,
  config,
  cpuTypist,
  idle,
  longRandoms,
  randoms,
  scripted,
  serveWords,
  withRetosses,
  type EngineCall,
  type Typist,
} from './engineHelpers';

const LEAD = TUNING.leadIn;
const NAMES = PLAYERS.map((p) => p.name.toUpperCase());

type EventOf<K extends GameEvent['type']> = Extract<GameEvent, { type: K }>;
const ofType = <K extends GameEvent['type']>(events: GameEvent[], type: K): EventOf<K>[] =>
  events.filter((e): e is EventOf<K> => e.type === type);

const newEngine = (seed = 1, over: Partial<MatchConfig> = {}): Engine =>
  new Engine({ config: config(over), players: PLAYERS, seed });

/** A copy of the engine's state, changed by `mutate`, restored into a new engine. */
function restored(e: Engine, mutate: (s: MatchState) => void): Engine {
  const s = JSON.parse(JSON.stringify(e.state)) as MatchState;
  mutate(s);
  return Engine.fromState(s);
}

/** Typists by player index, given who serves first. */
const byRole = (server: PlayerId, serverTypist: Typist, receiverTypist: Typist): [Typist, Typist] =>
  server === 0 ? [serverTypist, receiverTypist] : [receiverTypist, serverTypist];

function serveData(t: TurnState | null): ServeTurnData {
  if (t?.data.kind !== 'serve') throw new Error(`expected a serve turn, got ${t?.data.kind}`);
  return t.data;
}

function strikeOf(t: TurnState | null) {
  if (t?.outcome?.kind !== 'strike') throw new Error(`expected a strike, got ${JSON.stringify(t?.outcome)}`);
  return t.outcome.strike;
}

const words = (options: { word: string }[]): string[] => options.map((o) => o.word);

const cpu = (player: PlayerId, level: number, seed: number): Typist => cpuTypist(player, cpuProfile(level), seed);

describe('Engine: construction', () => {
  it('the first match-RNG draw decides the coin toss: < 0.5 means player 0 serves', () => {
    const servers = new Set<PlayerId>();
    for (let seed = 0; seed < 40; seed++) {
      const expected: PlayerId = uniform(seedRng(seed)) < 0.5 ? 0 : 1;
      const e = newEngine(seed);
      expect(e.owner()).toBe(expected);
      expect(e.state.score.firstServerOfMatch).toBe(expected);
      expect(e.state.score.gameServer).toBe(expected);
      servers.add(expected);
    }
    expect([...servers].sort()).toEqual([0, 1]);
  });

  it('opens with an intro serve turn: id 1, prompt base 1, two word sets and fresh randoms', () => {
    const e = newEngine(7, { pace: 'relaxed' });
    const s = e.state;
    const server = e.owner() as PlayerId;
    const d = serveData(s.turn);
    expect(d).toMatchObject({
      turnId: 1,
      promptBase: 1,
      owner: server,
      receiver: other(server),
      serveNo: 1,
      side: 'deuce',
      leadIn: { kind: 'intro', ms: LEAD.introMs, text: [`${NAMES[server]} TO SERVE`] },
      serveClockMs: TUNING.serveClockMs,
      tossApexMs: TUNING.tossApexMs,
      catchMs: TUNING.catchMs,
      pace: 1.5,
      freezeFirst: false,
    });
    expect(d.wordSets).toHaveLength(2);
    for (const set of d.wordSets) {
      expect(set.options.map((o) => o.tier)).toEqual(['easy', 'medium', 'hard']);
      expect(initialsOk(words(set.options))).toBe(true);
      expect(set.targets).toEqual(serveTargets(other(server), 'deuce', set.variant));
    }
    const [a, b] = d.wordSets.map((set) => words(set.options));
    expect(a?.filter((w) => b?.includes(w))).toEqual([]);
    expect(d.randoms).toHaveLength(9);
    for (const r of d.randoms) expect(r >= 0 && r < 1).toBe(true);
    expect(s.turn?.started).toBe(false);
    expect(s).toMatchObject({ status: 'playing', winner: null, forfeitBy: null, lastTurn: null, pointNo: 0 });
    expect(s.stats).toEqual([emptyStats(), emptyStats()]);
    expect(s.rng).not.toBeNull();
    expect(s.picker).not.toBeNull();
  });

  it('copies its config and players', () => {
    const cfg: MatchConfig = { ...CONFIG };
    const players = JSON.parse(JSON.stringify(PLAYERS)) as typeof PLAYERS;
    const e = new Engine({ config: cfg, players, seed: 3 });
    cfg.format = 'full';
    players[0].name = 'Changed';
    expect(e.state.config.format).toBe('short');
    expect(e.state.players[0].name).toBe('Alex');
  });

  it('start emits the coin toss at τ 0 before the turn start, once', () => {
    const e = newEngine(11);
    const server = e.owner() as PlayerId;
    const events = e.start(server);
    expect(events[0]).toEqual({ turn: 1, τ: 0, type: 'coinToss', winner: server });
    expect(events[1]).toMatchObject({ turn: 1, τ: 0, type: 'turnStart', owner: server, kind: 'serve' });
    expect(e.start(server)).toEqual([]);
    expect(ofType(e.clock(server, LEAD.introMs), 'coinToss')).toEqual([]);
  });
});

describe('Engine: ignored calls', () => {
  it('off-turn and unstarted inputs and clocks are ignored and produce no events', () => {
    const e = newEngine(5);
    const server = e.owner() as PlayerId;
    const receiver = other(server);
    const before = JSON.stringify(e.state);
    expect(e.input(server, 'toss', 3000)).toEqual([]);
    expect(e.clock(server, 3000)).toEqual([]);
    expect(e.start(receiver)).toEqual([]);
    expect(JSON.stringify(e.state)).toBe(before);

    e.start(server);
    const started = JSON.stringify(e.state);
    expect(e.input(receiver, 'toss', 3000)).toEqual([]);
    expect(e.input(receiver, 'a', 3000)).toEqual([]);
    expect(e.clock(receiver, 3000)).toEqual([]);
    expect(JSON.stringify(e.state)).toBe(started);
  });
});

describe('Engine: full matches', () => {
  it('50 CPU-vs-CPU short sets terminate: the set winner wins, every event τ is finite', { timeout: 120000 }, () => {
    for (let seed = 0; seed < 50; seed++) {
      const e = newEngine(seed);
      const driver = new Driver(e, [cpu(0, seed % 15, seed), cpu(1, (seed * 7 + 3) % 15, seed)]);
      driver.playMatch();
      const s = e.state;
      const winner = s.winner as PlayerId;
      expect(s.status).toBe('over');
      expect(winner === 0 || winner === 1).toBe(true);
      expect(s.score.winner).toBe(winner);
      expect(s.score.setsWon[winner]).toBe(1);
      const last = s.score.setGames[s.score.setGames.length - 1] as [number, number];
      expect(last[winner]).toBeGreaterThanOrEqual(4);
      expect(last[winner]).toBeGreaterThan(last[other(winner)]);
      expect(s.turn).toBeNull();
      expect(s.lastTurn?.ended).toBe(true);
      expect(e.owner()).toBeNull();
      expect(ofType(driver.events, 'match')).toEqual([expect.objectContaining({ winner })]);
      for (const ev of driver.events) expect(Number.isFinite(ev.τ)).toBe(true);
      const points = ofType(driver.events, 'point');
      expect(points).toHaveLength(s.pointNo);
      expect(s.stats[0].pointsWon + s.stats[1].pointsWon).toBe(s.pointNo);
      for (const p of [0, 1] as const) {
        expect(s.stats[p].aces).toBe(points.filter((x) => x.winner === p && x.reason === 'ace').length);
        expect(s.stats[p].doubleFaults).toBe(points.filter((x) => x.winner !== p && x.reason === 'doubleFault').length);
      }
      assertJsonSafe(s);
    }
  });
});

describe('Engine: determinism and restore', () => {
  const run = (seed: number): Driver => {
    const e = newEngine(seed, { format: 'tiebreak' });
    const d = new Driver(e, [cpu(0, 6, seed), cpu(1, 9, seed)]);
    d.playMatch();
    return d;
  };

  it('same seed and same scripted inputs give an identical state and event log', { timeout: 60000 }, () => {
    const a = run(1234);
    const b = run(1234);
    expect(JSON.stringify(b.engine.state)).toBe(JSON.stringify(a.engine.state));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(JSON.stringify(run(1235).engine.state)).not.toBe(JSON.stringify(a.engine.state));
  });

  it('fromState reproduces identical future behaviour from any recorded moment', { timeout: 60000 }, () => {
    const a = run(99);
    const calls: EngineCall[] = a.calls;
    for (const cut of [0, 1, Math.floor(calls.length / 3), Math.floor(calls.length / 2), calls.length - 2]) {
      const e = newEngine(99, { format: 'tiebreak' });
      calls.slice(0, cut).forEach((c) => apply(e, c));
      const snapshot = JSON.parse(JSON.stringify(e.state)) as MatchState;
      const b = Engine.fromState(snapshot);
      const events = calls.slice(cut).flatMap((c) => apply(b, c));
      expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.engine.state));
      expect(events.length).toBeGreaterThan(0);
    }
  });

  it('fromState copies its input and refuses a redacted state', () => {
    const e = newEngine(4);
    const s = JSON.parse(JSON.stringify(e.state)) as MatchState;
    const b = Engine.fromState(s);
    s.pointNo = 42;
    expect(b.state.pointNo).toBe(0);
    expect(() => Engine.fromState(redact(e.state, 'spectator'))).toThrow(/redacted|rng/i);
  });
});

describe('Engine: JSON safety', () => {
  it('state and its redactions survive a JSON round trip at 200 sampled moments', { timeout: 60000 }, () => {
    const play = (onCall?: (e: Engine) => void): number => {
      const e = newEngine(31);
      const d = new Driver(e, [withRetosses(cpu(0, 3, 31), 4), cpu(1, 10, 31)], { onCall: onCall && ((x) => onCall(x)) });
      d.playMatch();
      return d.calls.length;
    };
    const every = Math.floor(play() / 200);
    let n = 0;
    let samples = 0;
    play((e) => {
      if (++n % every !== 0) return;
      samples++;
      for (const v of [e.state, redact(e.state, 0), redact(e.state, 1), redact(e.state, 'spectator')]) {
        expect(JSON.parse(JSON.stringify(v))).toStrictEqual(v);
        assertJsonSafe(v);
      }
    });
    expect(samples).toBeGreaterThanOrEqual(200);
  });
});

describe('Engine: serve faults', () => {
  it('a first-serve fault leads to a second serve with a FAULT lead-in; a second is a double fault', () => {
    const e = newEngine(8);
    const server = e.owner() as PlayerId;
    const receiver = other(server);
    const d = new Driver(e, [idle, idle]);

    expect(d.playTurn()).toBe('ended');
    expect(ofType(d.events, 'call')).toEqual([
      { turn: 1, τ: LEAD.introMs + TUNING.serveClockMs, type: 'call', call: 'timeViolation', player: server },
    ]);
    const second = serveData(e.state.turn);
    expect(second).toMatchObject({
      turnId: 2,
      owner: server,
      receiver,
      serveNo: 2,
      side: 'deuce',
      leadIn: { kind: 'fault', ms: LEAD.faultMs, text: ['FAULT', 'TIME VIOLATION'] },
    });
    expect(e.state.lastTurn?.data.turnId).toBe(1);
    expect(ofType(d.events, 'point')).toEqual([]);

    const from = d.events.length;
    expect(d.playTurn()).toBe('ended');
    const events = d.events.slice(from);
    const endτ = LEAD.faultMs + TUNING.serveClockMs;
    expect(events.map((x) => x.type)).toEqual(['turnStart', 'preServe', 'call', 'turnEnd', 'call', 'point']);
    expect(events.slice(-2)).toEqual([
      { turn: 2, τ: endτ, type: 'call', call: 'doubleFault', player: server },
      { turn: 2, τ: endτ, type: 'point', winner: receiver, reason: 'doubleFault' },
    ]);
    expect(e.state.stats[server].doubleFaults).toBe(1);
    expect(e.state.stats[receiver].pointsWon).toBe(1);
    expect(e.state.score.points[receiver]).toBe(1);
    expect(serveData(e.state.turn)).toMatchObject({
      turnId: 3,
      serveNo: 1,
      side: 'ad',
      owner: server,
      leadIn: { kind: 'point', ms: LEAD.faultMs + LEAD.pointMs, text: ['FAULT', 'TIME VIOLATION', 'DOUBLE FAULT'] },
    });
  });

  it('a double fault is called FAULT with the second fault reason, then DOUBLE FAULT (spec §3.1)', () => {
    const e = newEngine(12);
    const server = e.owner() as PlayerId;
    const dropper = scripted({ letters: 1 });
    const secondServeOnly: Typist = (t) => (t.data.kind === 'serve' && t.data.serveNo === 2 ? dropper(t) : []);
    const d = new Driver(e, byRole(server, secondServeOnly, idle));
    d.playTurn();
    d.playTurn();
    expect(ofType(d.events, 'call').map((c) => c.call)).toEqual(['timeViolation', 'ballDropped', 'doubleFault']);
    expect(serveData(e.state.turn).leadIn).toEqual({
      kind: 'point',
      ms: LEAD.faultMs + LEAD.pointMs,
      text: ['FAULT', 'BALL DROPPED', 'DOUBLE FAULT'],
    });
  });

  it('a double fault that ends a game adds GAME <NAME> and the game extra after both calls', () => {
    const base = newEngine(8);
    const server = base.owner() as PlayerId;
    const receiver = other(server);
    const e = restored(base, (s) => {
      s.score.points[receiver] = 3;
    });
    const d = new Driver(e, [idle, idle]);
    d.playTurn();
    d.playTurn();
    expect(ofType(d.events, 'game')).toEqual([expect.objectContaining({ winner: receiver })]);
    expect(serveData(e.state.turn)).toMatchObject({
      owner: receiver,
      serveNo: 1,
      leadIn: {
        kind: 'point',
        ms: LEAD.faultMs + LEAD.pointMs + LEAD.gameExtraMs,
        text: ['FAULT', 'TIME VIOLATION', 'DOUBLE FAULT', `GAME ${NAMES[receiver]}`],
      },
    });
  });

  it('a locked word not finished by tooLow is a ball-dropped fault; its lock key still counts', () => {
    const e = newEngine(12);
    const server = e.owner() as PlayerId;
    const d = new Driver(e, byRole(server, scripted({ letters: 1 }), idle));
    d.playTurn();
    expect(ofType(d.events, 'call').map((c) => c.call)).toEqual(['ballDropped']);
    expect(serveData(e.state.turn).leadIn).toEqual({ kind: 'fault', ms: LEAD.faultMs, text: ['FAULT', 'BALL DROPPED'] });
    expect(e.state.stats[server]).toMatchObject({ correctKeys: 1, wrongKeys: 0, wordsCompleted: 0 });
  });

  it('a serve into the net is called in the return turn as a FAULT; the receiver typing is discarded', () => {
    const base = newEngine(21);
    const server = base.owner() as PlayerId;
    const receiver = other(server);
    const e = restored(base, (s) => {
      if (s.turn?.data.kind === 'serve') s.turn.data.randoms = randoms(0, 0.5, 0.5);
    });
    const d = new Driver(e, byRole(server, scripted({ slips: 1, keyMs: 100 }), scripted({ choice: 0, keyMs: 60 })));
    d.playTurn();
    const serve = strikeOf(e.state.lastTurn);
    expect(serve.shot.outcome).toBe('net');
    d.playTurn();
    const ret = e.state.lastTurn as TurnState;
    expect(ret.outcome).toMatchObject({ kind: 'call', call: 'net' });
    expect(ret.prompts[0]?.completedAt).not.toBeNull();
    expect(ofType(d.events, 'call')).toEqual([expect.objectContaining({ call: 'fault', player: server })]);
    expect(serveData(e.state.turn)).toMatchObject({
      serveNo: 2,
      owner: server,
      leadIn: { kind: 'fault', ms: LEAD.faultMs, text: ['FAULT', 'NET'] },
    });
    expect(e.state.stats[receiver]).toEqual(emptyStats());
    expect(e.state.stats[server]).toMatchObject({ wordsCompleted: 1, wrongKeys: 1, errors: 0, fastestServeKmh: 0 });
    expect(e.state.rallyStrikes).toBe(0);
  });
});

describe('Engine: points', () => {
  it('an unanswered serve is an ACE for the server', () => {
    const e = newEngine(3);
    const server = e.owner() as PlayerId;
    const receiver = other(server);
    const d = new Driver(e, byRole(server, scripted(), idle));
    d.playTurn();
    const serve = strikeOf(e.state.lastTurn);
    expect(serve.shot.outcome).toBe('in');
    const ret = e.state.turn as TurnState;
    expect(ret.data).toMatchObject({ kind: 'return', turnId: 2, owner: receiver, striker: server, isServeReturn: true, n: 0 });
    d.playTurn();
    const end = (e.state.lastTurn as TurnState).outcome?.endτ;
    expect(ofType(d.events, 'call')).toEqual([{ turn: 2, τ: end, type: 'call', call: 'ace', player: receiver }]);
    expect(ofType(d.events, 'point')).toEqual([{ turn: 2, τ: end, type: 'point', winner: server, reason: 'ace' }]);
    expect(e.state.stats[server]).toMatchObject({ aces: 1, pointsWon: 1, winners: 0, fastestServeKmh: serve.kmh });
    expect(e.state.longestRally).toBe(1);
    expect(e.state.rallyStrikes).toBe(0);
    expect(e.state.pointNo).toBe(1);
    expect(serveData(e.state.turn)).toMatchObject({ owner: server, serveNo: 1, side: 'ad', leadIn: { kind: 'point', ms: LEAD.pointMs, text: ['ACE!'] } });
  });

  it('a ball chased but not returned is a WINNER; the chase word counts in the receiver stats', () => {
    const e = newEngine(3);
    const server = e.owner() as PlayerId;
    const receiver = other(server);
    const d = new Driver(e, byRole(server, scripted(), scripted({ choice: null })));
    d.playTurn();
    d.playTurn();
    expect(ofType(d.events, 'point')).toEqual([expect.objectContaining({ winner: server, reason: 'winner' })]);
    expect(ofType(d.events, 'call')).toEqual([expect.objectContaining({ call: 'winner', player: receiver })]);
    expect(e.state.stats[server]).toMatchObject({ aces: 0, winners: 1, pointsWon: 1 });
    expect(e.state.stats[receiver].wordsCompleted).toBe(1);
    expect(serveData(e.state.turn).leadIn.text).toEqual(['WINNER']);
  });

  it('a rally ball hit long is called OUT: point to its receiver, an error for the striker, typing discarded', () => {
    const e = newEngine(17);
    const server = e.owner() as PlayerId;
    const receiver = other(server);
    const d = new Driver(
      e,
      byRole(server, scripted({ choice: null, keyMs: 50 }), scripted({ choice: 2, slips: 1, keyMs: 90 })),
    );
    d.playTurn();
    const ret = e.state.turn as TurnState;
    ret.data.randoms = longRandoms(server);
    d.playTurn();
    const shot = strikeOf(e.state.lastTurn);
    expect(shot).toMatchObject({ player: receiver, slips: 1, isServe: false, stretch: false });
    expect(shot.word.tier).toBe('hard');
    expect(shot.shot.outcome).toBe('out');
    expect(e.state.turn?.data).toMatchObject({ kind: 'return', owner: server, striker: receiver, isServeReturn: false, n: 1 });
    expect(e.state.rallyStrikes).toBe(2);

    d.playTurn();
    const called = e.state.lastTurn as TurnState;
    expect(called.outcome).toMatchObject({ kind: 'call', call: 'out' });
    expect(called.prompts[0]?.completedAt).not.toBeNull();
    expect(ofType(d.events, 'call')).toEqual([expect.objectContaining({ call: 'out', player: receiver })]);
    expect(ofType(d.events, 'point')).toEqual([expect.objectContaining({ winner: server, reason: 'out' })]);
    expect(e.state.stats[receiver]).toMatchObject({ errors: 1, pointsWon: 0, wordsCompleted: 2 });
    expect(e.state.stats[server]).toMatchObject({ errors: 0, pointsWon: 1, wordsCompleted: 1 });
    expect(e.state.longestRally).toBe(2);
    expect(serveData(e.state.turn).leadIn).toEqual({ kind: 'point', ms: LEAD.pointMs, text: ['OUT'] });
  });

  /** An engine whose server is one point from the game, with `games` for the server, then an ace. */
  function aceAtGamePoint(format: MatchConfig['format'], games: number) {
    const base = newEngine(3, { format });
    const server = base.owner() as PlayerId;
    const e = restored(base, (s) => {
      s.score.points[server] = 3;
      s.score.games[server] = games;
    });
    const d = new Driver(e, byRole(server, scripted(), idle));
    d.playTurn();
    d.playTurn();
    return { e, d, server, name: NAMES[server] };
  }

  it('winning a game adds GAME <NAME> to the lead-in and the game extra time', () => {
    const { e, d, server, name } = aceAtGamePoint('short', 0);
    expect(ofType(d.events, 'game')).toEqual([expect.objectContaining({ winner: server })]);
    expect(ofType(d.events, 'set')).toEqual([]);
    expect(serveData(e.state.turn)).toMatchObject({
      owner: other(server),
      leadIn: { kind: 'point', ms: LEAD.pointMs + LEAD.gameExtraMs, text: ['ACE!', `GAME ${name}`] },
    });
  });

  it('winning a set (best of three) adds SET <NAME> and the set extra time', () => {
    const { e, d, server, name } = aceAtGamePoint('bo3', 3);
    expect(ofType(d.events, 'set')).toEqual([expect.objectContaining({ winner: server })]);
    expect(ofType(d.events, 'match')).toEqual([]);
    expect(e.state.status).toBe('playing');
    expect(serveData(e.state.turn).leadIn).toEqual({
      kind: 'point',
      ms: LEAD.pointMs + LEAD.gameExtraMs + LEAD.setExtraMs,
      text: ['ACE!', `GAME ${name}`, `SET ${name}`],
    });
  });

  it('the final point ends the match: match event, no next turn, lastTurn kept', () => {
    const { e, d, server } = aceAtGamePoint('short', 3);
    const kinds = d.events.slice(-4).map((x) => x.type);
    expect(kinds).toEqual(['point', 'game', 'set', 'match']);
    expect(ofType(d.events, 'match')).toEqual([expect.objectContaining({ turn: 2, winner: server })]);
    expect(e.state).toMatchObject({ status: 'over', winner: server, turn: null });
    expect(e.state.lastTurn?.data.turnId).toBe(2);
    expect(e.owner()).toBeNull();
    expect(e.start(server)).toEqual([]);
    expect(e.clock(server, 1e6)).toEqual([]);
  });

  it('forfeit ends the match for the other player', () => {
    const e = newEngine(6);
    const server = e.owner() as PlayerId;
    e.start(server);
    e.clock(server, 1000);
    expect(e.forfeit(server)).toEqual([{ turn: 1, τ: 1000, type: 'match', winner: other(server) }]);
    expect(e.state).toMatchObject({ status: 'over', winner: other(server), forfeitBy: server, turn: null });
    expect(e.state.score.winner).toBe(other(server));
    expect(e.state.lastTurn?.data.turnId).toBe(1);
    expect(e.owner()).toBeNull();
    expect(e.forfeit(other(server))).toEqual([]);
    expect(e.input(server, 'toss', 3000)).toEqual([]);
  });
});

describe('Engine: situation banners', () => {
  it('announces the situation when PRE_SERVE begins, once per serve turn', () => {
    const base = newEngine(2);
    const server = base.owner() as PlayerId;
    const e = restored(base, (s) => {
      s.score.points = [3, 3];
    });
    e.start(server);
    const events = e.clock(server, LEAD.introMs);
    expect(events.map((x) => x.type)).toEqual(['preServe', 'situation']);
    expect(events[1]).toEqual({ turn: 1, τ: LEAD.introMs, type: 'situation', text: 'DEUCE' });
    e.input(server, 'toss', 3000);
    const afterCatch = e.clock(server, 3000 + 2 * TUNING.tossApexMs + TUNING.catchMs);
    expect(afterCatch.map((x) => x.type)).toEqual(['catch', 'preServe']);
  });

  it('announces nothing when no situation applies', () => {
    const e = newEngine(2);
    const server = e.owner() as PlayerId;
    e.start(server);
    expect(e.clock(server, LEAD.introMs).map((x) => x.type)).toEqual(['preServe']);
  });
});

describe('Engine: serve word sets', () => {
  it('a catch appends a new spare set; a re-toss never repeats the previous toss', () => {
    for (let seed = 0; seed < 30; seed++) {
      const e = newEngine(seed);
      const server = e.owner() as PlayerId;
      const d = new Driver(e, byRole(server, scripted({ serve: null }), idle));
      d.playTurn();
      const t = e.state.lastTurn as TurnState;
      const catches = t.log.filter((x) => x.k === 'catch').length;
      expect(catches).toBeGreaterThanOrEqual(6);
      expect(ofType(d.events, 'catch')).toHaveLength(catches);
      const sets = serveData(t).wordSets.map((s) => words(s.options));
      expect(sets).toHaveLength(catches + 2);
      const tossed = t.prompts.map((p) => words(p.options));
      expect(tossed).toEqual(sets.slice(0, tossed.length));
      sets.forEach((set, i) => {
        const next = sets[i + 1] ?? [];
        expect(set.filter((w) => next.includes(w))).toEqual([]);
        expect(initialsOk(set)).toBe(true);
      });
      const receiver = other(server);
      for (const set of serveData(t).wordSets) {
        expect(set.targets).toEqual(serveTargets(receiver, 'deuce', set.variant));
      }
    }
  });
});

describe('Engine: turn ids and prompt ids', () => {
  it('a turn after two re-tosses starts after their prompts; a turn after one prompt starts 2 after its base', () => {
    const e = newEngine(44);
    const server = e.owner() as PlayerId;
    const serve = scripted();
    const thirdToss: Typist = (t) => (t.phase === 'toss' && t.prompts.length < 3 ? [] : serve(t));
    const d = new Driver(e, byRole(server, thirdToss, idle));
    d.playTurn();
    expect(e.state.lastTurn?.prompts.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(e.state.turn?.data).toMatchObject({ kind: 'return', turnId: 2, promptBase: 4 });
    d.playTurn();
    expect(e.state.lastTurn?.prompts.map((p) => p.id)).toEqual([4]);
    expect(e.state.turn?.data).toMatchObject({ kind: 'serve', turnId: 3, promptBase: 6 });
  });

  it('over a whole match, turn ids count up from 1 and each promptBase follows every prompt id used before', { timeout: 60000 }, () => {
    const e = newEngine(44, { format: 'tiebreak' });
    const d = new Driver(e, [withRetosses(cpu(0, 5, 44), 3), withRetosses(cpu(1, 8, 44), 2)]);
    let maxUsed = 0;
    let prevBase = -Infinity;
    let turns = 0;
    while (e.state.status === 'playing') {
      const t = e.state.turn as TurnState;
      expect(t.data.turnId).toBe(++turns);
      expect(t.data.promptBase).toBe(Math.max(maxUsed + 1, prevBase + 2));
      d.playTurn();
      const ended = e.state.lastTurn as TurnState;
      for (const p of ended.prompts) expect(p.id).toBeGreaterThanOrEqual(ended.data.promptBase);
      maxUsed = Math.max(maxUsed, ...ended.prompts.map((p) => p.id));
      prevBase = ended.data.promptBase;
    }
    expect(turns).toBeGreaterThanOrEqual(20);
  });
});

describe('Engine: training flags', () => {
  const S0 = ['cat', 'garden', 'playground'];
  const S1 = ['hat', 'orange', 'strawberry'];
  const S2 = ['dog', 'pencil', 'motorcycle'];
  const C0 = ['bus', 'teacher', 'lighthouse'];
  const C1 = ['cup', 'rainbow', 'waterfalls'];
  const training = (over: Partial<TrainingFlags> = {}): TrainingFlags => ({
    serveClock: false,
    freezeUntilFirstKey: false,
    fixedWords: { serve: [S0, S1, S2], choice: [C0, C1] },
    ...over,
  });

  it('uses valid fixture triples', () => {
    for (const t of [S0, S1, S2, C0, C1]) expect(initialsOk(t)).toBe(true);
  });

  it('serveClock false: no serve clock and no time violation after 60 s idle', () => {
    const e = newEngine(1, { training: training({ fixedWords: null }), pace: 'relaxed' });
    const server = e.owner() as PlayerId;
    expect(serveData(e.state.turn).serveClockMs).toBeNull();
    e.start(server);
    const events = e.clock(server, 60000);
    expect(events.map((x) => x.type)).toEqual(['preServe']);
    expect(e.state.turn?.phase).toBe('preServe');
    expect(e.state.turn?.ended).toBe(false);
  });

  it('fixed words are used in order and cycle, for serves (spares included) and choices', () => {
    const e = newEngine(1, { training: training() });
    const server = e.owner() as PlayerId;
    const sets = (): string[][] => serveData(e.state.turn).wordSets.map((s) => words(s.options));
    expect(sets()).toEqual([S0, S1]);
    const a = 2 * TUNING.tossApexMs;
    e.start(server);
    let τ = LEAD.introMs;
    e.clock(server, τ);
    for (const expected of [[S0, S1, S2], [S0, S1, S2, S0]]) {
      e.input(server, 'toss', τ);
      e.clock(server, (τ += a));
      expect(sets()).toEqual(expected);
      e.clock(server, (τ += TUNING.catchMs));
    }
    e.input(server, 'toss', τ);
    for (const ch of S2[0] as string) e.input(server, ch, (τ += 100));
    expect(strikeOf(e.state.lastTurn).word.word).toBe(S2[0]);
    const ret = e.state.turn as TurnState;
    expect(ret.data.kind === 'return' && words(ret.data.choice.options)).toEqual(C0);
    const d = new Driver(e, byRole(server, scripted(), scripted({ keyMs: 60 })));
    d.playTurn();
    const next = e.state.turn as TurnState;
    expect(next.data.owner).toBe(server);
    expect(next.data.kind === 'return' && words(next.data.choice.options)).toEqual(C1);
  });

  describe('first-prompt freezes belong to the trainee (spec §3.12)', () => {
    const HUMAN: PlayerId = 0;
    const CPU: PlayerId = 1;
    const TRAINEE: [PlayerInfo, PlayerInfo] = [{ ...PLAYERS[0], kind: 'human', cpuLevel: null }, PLAYERS[1]];
    const seedServedBy = (p: PlayerId): number => {
      for (let seed = 0; ; seed++) if ((uniform(seedRng(seed)) < 0.5 ? 0 : 1) === p) return seed;
    };
    const trainee = (seed: number): Engine =>
      new Engine({ config: config({ pace: 'relaxed', training: training({ freezeUntilFirstKey: true }) }), players: TRAINEE, seed });

    /** The kinds of the prompts that froze the simulation in turn `t`, in order. */
    function frozenKinds(t: TurnState): PromptKind[] {
      let shown: number | null = null;
      const kinds: PromptKind[] = [];
      for (const x of t.log) {
        if (x.k === 'show') shown = x.prompt;
        if (x.k === 'freeze' && x.on) kinds.push(t.prompts.find((p) => p.id === shown)?.kind as PromptKind);
      }
      return kinds;
    }

    /** Plays the current turn with shot randoms that always land IN; returns it once ended. */
    const playIn = (e: Engine, d: Driver): TurnState => {
      (e.state.turn as TurnState).data.randoms = randoms(0.999, 0.5, 0.5);
      expect(d.playTurn()).toBe('ended');
      return e.state.lastTurn as TurnState;
    };

    it('trainee serves first: the CPU return never freezes, and the trainee first chase and choice still do', () => {
      const e = trainee(seedServedBy(HUMAN));
      const d = new Driver(e, [scripted(), scripted({ keyMs: 60 })]);
      const serve = playIn(e, d);
      expect(serve.data).toMatchObject({ kind: 'serve', owner: HUMAN, freezeFirst: true });
      expect(frozenKinds(serve)).toEqual(['serve']);

      const cpuReturn = playIn(e, d);
      expect(cpuReturn.data).toMatchObject({ kind: 'return', owner: CPU, freezeFirst: false });
      expect(frozenKinds(cpuReturn)).toEqual([]);
      expect(cpuReturn.outcome?.kind).toBe('strike');
      expect(e.state.turn?.seenKinds).toEqual(['serve']);

      const humanReturn = playIn(e, d);
      expect(humanReturn.data).toMatchObject({ kind: 'return', owner: HUMAN, freezeFirst: true });
      expect(frozenKinds(humanReturn)).toEqual(['chase', 'choice']);
      expect(e.state.seenKinds).toEqual([['serve', 'chase', 'choice'], ['chase', 'choice']]);
    });

    it('CPU serves first: its serve never freezes, and the trainee first serve still does', () => {
      const e = trainee(seedServedBy(CPU));
      const serveOnly = scripted({ keyMs: 60 });
      const d = new Driver(e, [scripted(), (t) => (t.data.kind === 'serve' ? serveOnly(t) : [])]);
      const played: TurnState[] = [];
      for (let i = 0; i < 40 && !(e.state.turn?.data.kind === 'serve' && e.state.turn.data.owner === HUMAN); i++) {
        played.push(playIn(e, d));
      }
      expect(played[0]?.data).toMatchObject({ kind: 'serve', owner: CPU, freezeFirst: false });
      expect(played[1]?.data).toMatchObject({ kind: 'return', owner: HUMAN, freezeFirst: true });
      expect(frozenKinds(played[1] as TurnState)).toEqual(['chase', 'choice']);
      for (const t of played) {
        if (t.data.owner === CPU) expect([t.data.freezeFirst, frozenKinds(t)]).toEqual([false, []]);
        else expect(frozenKinds(t)).toEqual(t === played[1] ? ['chase', 'choice'] : []);
      }

      const humanServe = e.state.turn as TurnState;
      expect(humanServe.data).toMatchObject({ kind: 'serve', owner: HUMAN, freezeFirst: true });
      expect(humanServe.seenKinds).toEqual(['chase', 'choice']);
      expect(frozenKinds(playIn(e, d))).toEqual(['serve']);
    });

    it('per-player seenKinds survive fromState', () => {
      const e = trainee(seedServedBy(HUMAN));
      const d = new Driver(e, [scripted(), scripted({ keyMs: 60 })]);
      playIn(e, d);
      playIn(e, d);
      const b = Engine.fromState(JSON.parse(JSON.stringify(e.state)) as MatchState);
      expect(b.state.seenKinds).toEqual([['serve'], ['chase', 'choice']]);
      expect(b.state.turn?.seenKinds).toEqual(['serve']);
    });
  });

  it('rejects an invalid training word list at construction', () => {
    const bad = (fixedWords: TrainingFlags['fixedWords']) => () =>
      new Engine({ config: config({ training: training({ fixedWords }) }), players: PLAYERS, seed: 1 });
    expect(bad({ serve: [['sun', 'window', 'basketball']], choice: [C0] })).toThrow(/training/i);
    expect(bad({ serve: [S0], choice: [['teacher', 'bus', 'lighthouse']] })).toThrow(/training/i);
    expect(bad({ serve: [['cat', 'garden']], choice: [C0] })).toThrow(/training/i);
    expect(bad({ serve: [['Cat', 'garden', 'playground']], choice: [C0] })).toThrow(/training/i);
    expect(bad({ serve: [], choice: [C0] })).toThrow(/training/i);
    expect(bad({ serve: [S0], choice: [C0] })).not.toThrow();
  });
});

describe('Engine: extreme typists (Review Focus 2)', () => {
  const FAST: CpuProfile = { wpm: 160, err: 0.01, reactionMs: 200, aggression: 0.95 };
  const SLOW: CpuProfile = { wpm: 15, err: 0.08, reactionMs: 1000, aggression: 0.1 };

  /** Plays a match, checking every strike's flight and every event. */
  function checkedMatch(seed: number, typists: [Typist, Typist]): Driver {
    const e = newEngine(seed);
    const d = new Driver(e, typists);
    while (e.state.status === 'playing') {
      expect(d.playTurn()).not.toBe('stalled');
      const t = e.state.lastTurn;
      if (t?.outcome?.kind !== 'strike') continue;
      const { flight, v, cps, kmh } = t.outcome.strike;
      for (const x of [flight.T, flight.tBounce, flight.grace, v, cps, kmh]) expect(Number.isFinite(x)).toBe(true);
      expect(flight.T).toBeGreaterThan(0);
      expect(flight.grace).toBeGreaterThan(0);
    }
    for (const ev of d.events) expect(Number.isFinite(ev.τ) && ev.τ >= 0).toBe(true);
    for (const st of e.state.stats) {
      expect(Number.isFinite(averageWpm(st))).toBe(true);
      expect(Number.isFinite(accuracy(st))).toBe(true);
    }
    assertJsonSafe(e.state);
    expect(e.state.status).toBe('over');
    return d;
  }

  it('a typist who never types still finishes the match: every point an ace or a double fault', { timeout: 60000 }, () => {
    for (const seed of [1, 2, 3]) {
      for (const [a, b] of [[idle, cpu(1, 0, seed)], [cpu(0, 0, seed), idle]] as [Typist, Typist][]) {
        const d = checkedMatch(seed, [a, b]);
        const reasons = ofType(d.events, 'point').map((p) => p.reason);
        expect(reasons.length).toBeGreaterThan(0);
        for (const r of reasons) expect(['ace', 'doubleFault']).toContain(r);
      }
    }
  });

  it('160 WPM and 15 WPM typists: no NaN, every T positive', { timeout: 60000 }, () => {
    for (const seed of [1, 2]) {
      checkedMatch(seed, [cpuTypist(0, FAST, seed), cpuTypist(1, FAST, seed)]);
      checkedMatch(seed, [cpuTypist(0, SLOW, seed), cpuTypist(1, SLOW, seed)]);
      checkedMatch(seed, [cpuTypist(0, FAST, seed), cpuTypist(1, SLOW, seed)]);
    }
  });
});

describe('Engine: stats', () => {
  it('emptyStats, averageWpm and accuracy', () => {
    const s = emptyStats();
    expect(Object.values(s).every((v) => v === 0)).toBe(true);
    expect(averageWpm(s)).toBe(0);
    expect(accuracy(s)).toBe(0);
    expect(averageWpm({ ...s, intervalSum: 30, typingMs: 6000 })).toBeCloseTo(60, 10);
    expect(accuracy({ ...s, correctKeys: 90, wrongKeys: 10 })).toBeCloseTo(0.9, 10);
  });

  it('typing stats come from the completed words and keys of the typist prompts', () => {
    const base = newEngine(5);
    const server = base.owner() as PlayerId;
    const e = restored(base, (s) => {
      if (s.turn?.data.kind === 'serve') s.turn.data.randoms = randoms(0.999, 0.5, 0.5);
    });
    const d = new Driver(e, byRole(server, scripted({ serve: 1, slips: 1 }), idle));
    d.playTurn();
    const p = e.state.lastTurn?.prompts[0] as PromptState;
    const strike = strikeOf(e.state.lastTurn);
    expect(strike.shot.outcome).toBe('in');
    expect(e.state.stats[server]).toEqual({
      ...emptyStats(),
      wordsCompleted: 1,
      intervalSum: p.typed - 1,
      typingMs: (p.tLast as number) - (p.tFirst as number),
      topWpm: wpmOf(wordCps(p)),
      correctKeys: p.typed,
      wrongKeys: 1,
      fastestServeKmh: strike.kmh,
    });
  });
});
