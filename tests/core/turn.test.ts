import { describe, expect, it } from 'vitest';
import { rallyTargets, restSpot, serverSpot, serveTargets } from '../../src/core/court';
import { ballAt, stanceFor } from '../../src/core/trajectory';
import {
  appendWordSet,
  createTurn,
  MAX_EARLY_KEYS,
  nextDeadline,
  simTime,
  startTurn,
  turnClock,
  turnInput,
} from '../../src/core/turn';
import { TUNING } from '../../src/core/tuning';
import { serveClockτ } from '../../src/core/turnServe';
import { flightTimeMs } from '../../src/core/shot';
import type {
  GameEvent,
  ReturnTurnData,
  ServeTurnData,
  ServeWordSet,
  StrikeInfo,
  TurnState,
  Vec2,
} from '../../src/core/types';
import {
  CHOICE,
  CHOICE_4,
  flight,
  INSANE_WORD,
  opt,
  RALLY_IN,
  RALLY_OUT,
  returnData,
  SET_A,
  SET_B,
  serveData,
  serveSet,
} from './turnFixtures';

/** A spare serve word set for `appendWordSet`. */
const SET_C = ['net', 'umpire', 'grandslams'];

const RALLY_NET = flight({ outcome: 'net' });
const SERVE_IN = flight({ isServe: true, tier: 'easy', p0: { x: 0.8, y: -12.3, z: 2.6 }, landing: serveTargets(1, 'deuce', 'T')[0]! });
const SERVE_OUT = flight({ isServe: true, tier: 'easy', p0: { x: 0.8, y: -12.3, z: 2.6 }, landing: { x: -0.5, y: 5 }, outcome: 'out' });
const SERVE_NET = flight({ isServe: true, tier: 'easy', p0: { x: 0.8, y: -12.3, z: 2.6 }, landing: { x: 2, y: 5 }, outcome: 'net' });

/** Types `word` one key every `step` ms from `from`; returns all events. */
function type(t: TurnState, word: string, from: number, step = 100): GameEvent[] {
  return [...word].flatMap((ch, i) => turnInput(t, ch, from + i * step));
}

const tags = (events: GameEvent[]): string[] => events.map((e) => `${e.type}@${e.τ}`);

const wordSetsOf = (t: TurnState): ServeWordSet[] => (t.data.kind === 'serve' ? t.data.wordSets : []);

/** Spec §3.4 speed factor, written out independently of shot.ts. */
const speed = (cps: number): number => Math.min(1.3, Math.max(0.8, 0.875 + 0.025 * (cps - 3)));

function strikeOf(t: TurnState): StrikeInfo {
  if (t.outcome?.kind !== 'strike') throw new Error(`expected a strike, got ${JSON.stringify(t.outcome)}`);
  return t.outcome.strike;
}

function started(t: TurnState): TurnState {
  startTurn(t);
  return t;
}

/** A started serve turn in PRE_SERVE with the ball tossed at `tossAt`. */
function tossed(tossAt = 3000, over: Partial<ServeTurnData> = {}): TurnState {
  const t = started(createTurn(serveData(over)));
  turnClock(t, tossAt);
  turnInput(t, 'toss', tossAt);
  return t;
}

/** A started return turn whose chase word was typed at 100..400 (choice shown at 400). */
function chased(over: Partial<ReturnTurnData> = {}): TurnState {
  const t = started(createTurn(returnData(over)));
  type(t, 'ball', 100);
  return t;
}

describe('serve turn', () => {
  it('starts in the lead-in and enters PRE_SERVE at leadIn.ms', () => {
    const t = createTurn(serveData());
    expect(t.phase).toBe('leadIn');
    expect(t.started).toBe(false);
    const start = startTurn(t);
    expect(start).toEqual([{ turn: 7, τ: 0, type: 'turnStart', owner: 0, kind: 'serve' }]);
    expect(turnClock(t, 2499)).toEqual([]);
    expect(t.phase).toBe('leadIn');
    expect(turnClock(t, 2500)).toEqual([
      { turn: 7, τ: 2500, type: 'preServe', server: 0, serveNo: 1, side: 'deuce' },
    ]);
    expect(t.phase).toBe('preServe');
  });

  it('happy path: toss at 3000, "ball" at 3400..3700 strikes at 3700 with contact factor 1', () => {
    const t = started(createTurn(serveData()));
    turnClock(t, 2500);
    expect(tags(turnInput(t, 'toss', 3000))).toEqual(['toss@3000', 'promptShown@3000']);
    expect(t.phase).toBe('toss');
    expect(t.tossAt).toBe(3000);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]!.id).toBe(40);
    expect(t.prompts[0]!.kind).toBe('serve');
    expect(t.prompts[0]!.options).toEqual(SET_A.map(opt));

    const events = type(t, 'ball', 3400);
    expect(tags(events)).toEqual([
      'lock@3400', 'keyOk@3500', 'keyOk@3600', 'keyOk@3700', 'wordDone@3700', 'strike@3700', 'power@3700', 'turnEnd@3700',
    ]);
    expect(t.ended).toBe(true);
    expect(t.phase).toBe('ended');
    expect(t.outcome?.endτ).toBe(3700);

    const s = strikeOf(t);
    const cps = 3 / 0.3;
    const v = speed(cps);
    expect(s.τ).toBe(3700);
    expect(s.player).toBe(0);
    expect(s.word).toEqual(opt('ball'));
    expect(s.option).toBe(0);
    expect(s.cps).toBeCloseTo(cps, 9);
    expect(s.wpm).toBeCloseTo(cps * 12, 9);
    expect(s.v).toBeCloseTo(v, 12);
    expect(s.stretch).toBe(false);
    expect(s.isServe).toBe(true);
    expect(s.forehand).toBe(true);
    expect(s.target).toEqual(serveTargets(1, 'deuce', 'T')[0]);
    expect(s.shot.outcome).toBe('in');
    expect(s.shot.landing.x).toBeCloseTo(s.target.x, 12);
    expect(s.shot.landing.y).toBeCloseTo(s.target.y, 12);
    expect(s.kmh).toBe(Math.round(95 * v * 1.0 * 1.25));
    // Serve T: pace·(2.2 s + 0.1 s·len)/v · place 1 · 0.85⁰ + (0.5 s + 0.5 s·pace).
    expect(s.flight.T).toBeCloseTo((2200 + 100 * 4) / v + 1000, 6);
    expect(s.flight.grace).toBe(400);
    expect(s.flight.isServe).toBe(true);
    expect(s.flight.destEnd).toBe(1);
    const spot = serverSpot(0, 'deuce');
    // Toss height 700 ms after the toss: 1.8 + 1.4·(1 − ((700 − 2000)/2000)²).
    expect(s.flight.p0.x).toBe(spot.x);
    expect(s.flight.p0.y).toBe(spot.y);
    expect(s.flight.p0.z).toBeCloseTo(1.8 + 1.4 * (1 - 0.65 * 0.65), 12);
    const done = events.find((e) => e.type === 'wordDone');
    expect(done).toMatchObject({ player: 0, prompt: 40, wpm: s.wpm });
    expect(events.find((e) => e.type === 'strike')).toEqual({
      turn: 7, τ: 3700, type: 'strike', player: 0, word: 'ball', tier: 'easy', kmh: s.kmh, isServe: true, stretch: false, forehand: true,
    });
    expect(events.at(-1)).toEqual({ turn: 7, τ: 3700, type: 'turnEnd', endτ: 3700 });
  });

  it('after the apex: completion at tossAt + 1.5a multiplies v by the contact factor 0.925', () => {
    const t = tossed(3000);
    type(t, 'ball', 5700);
    const s = strikeOf(t);
    expect(s.τ).toBe(6000);
    expect(s.v).toBeCloseTo(speed(3 / 0.3) * 0.925, 12);
    expect(s.flight.p0.z).toBeCloseTo(1.8 + 1.4 * (1 - 0.5 * 0.5), 12);
  });

  it('carries the shot word\'s slips into accuracy (σ = σ0 + σe·e)', () => {
    const t = tossed(3000);
    turnInput(t, 'b', 3400);
    turnInput(t, 'x', 3450);
    turnInput(t, 'y', 3460);
    const events = type(t, 'all', 3500);
    const s = strikeOf(t);
    expect(s.slips).toBe(1);
    expect(s.shot.sigma).toBeCloseTo(0.1 + 0.25, 12);
    expect(t.prompts[0]!.wrongKeys).toBe(2);
    expect(events.filter((e) => e.type === 'keyOk')).toHaveLength(3);
  });

  it('emits keyBad for a wrong key and nothing for a key matching no initial', () => {
    const t = tossed(3000);
    expect(turnInput(t, 'z', 3100)).toEqual([]);
    expect(t.prompts[0]!.locked).toBeNull();
    expect(tags(turnInput(t, 'v', 3200))).toEqual(['lock@3200']);
    expect(turnInput(t, 'v', 3200)[0]).toEqual({ turn: 7, τ: 3200, type: 'keyBad', player: 0, prompt: 40 });
  });

  it('ball dropped: a locked, unfinished word faults at tossAt + 2a', () => {
    const t = tossed(3000);
    type(t, 'ba', 3200);
    expect(turnClock(t, 6999)).toEqual([]);
    expect(turnClock(t, 7000)).toEqual([
      { turn: 7, τ: 7000, type: 'call', call: 'ballDropped', player: 0 },
      { turn: 7, τ: 7000, type: 'turnEnd', endτ: 7000 },
    ]);
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 7000, reason: 'ballDropped' });
    expect(t.phase).toBe('ended');
    expect(t.active).toBeNull();
  });

  it('catch and re-toss: catch at tossAt + 2a, PRE_SERVE after catchMs, next toss uses the spare set', () => {
    const t = tossed(3000);
    expect(tags(turnClock(t, 7000))).toEqual(['catch@7000']);
    expect(t.phase).toBe('catch');
    expect(t.catchAt).toBe(7000);
    expect(t.active).toBeNull();
    expect(turnInput(t, 'b', 7100)).toEqual([]);
    expect(turnInput(t, 'toss', 7200)).toEqual([]);
    expect(turnClock(t, 7500)).toEqual([
      { turn: 7, τ: 7500, type: 'preServe', server: 0, serveNo: 1, side: 'deuce' },
    ]);
    expect(t.phase).toBe('preServe');
    expect(t.setIndex).toBe(1);
    expect(t.tossAt).toBeNull();
    expect(t.catchAt).toBeNull();

    expect(tags(turnInput(t, 'toss', 8000))).toEqual(['toss@8000', 'promptShown@8000']);
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]!.id).toBe(41);
    expect(t.prompts[1]!.options).toEqual(SET_B.map(opt));
    expect(tags(turnClock(t, 12500))).toEqual(['catch@12000', 'preServe@12500']);
    expect(t.setIndex).toBe(2);

    // No spare left: the toss is ignored until the engine appends one.
    expect(turnInput(t, 'toss', 13000)).toEqual([]);
    expect(t.phase).toBe('preServe');
    appendWordSet(t, serveSet(SET_C));
    expect(tags(turnInput(t, 'toss', 13100))).toEqual(['toss@13100', 'promptShown@13100']);
    expect(t.prompts[2]!.options).toEqual(SET_C.map(opt));
    type(t, 'net', 13500);
    expect(strikeOf(t).target).toEqual(serveTargets(1, 'deuce', 'T')[0]);
    expect(t.log.filter((e) => e.k === 'catch').map((e) => e.τ)).toEqual([7000, 12000]);
  });

  it('serve clock: expiry in PRE_SERVE is a time violation at leadIn + 30000', () => {
    const t = started(createTurn(serveData()));
    expect(tags(turnClock(t, 40000))).toEqual(['preServe@2500', 'call@32500', 'turnEnd@32500']);
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 32500, reason: 'timeViolation' });
  });

  it('serve clock: expiry during the toss lets a completed word strike normally', () => {
    const t = tossed(31000);
    expect(turnClock(t, 32600)).toEqual([]);
    type(t, 'ball', 32700);
    expect(strikeOf(t).τ).toBe(33000);
  });

  it('serve clock: expiry during the toss turns a catch into a time violation at the catch end', () => {
    const t = tossed(31000);
    const events = turnClock(t, 40000);
    expect(tags(events)).toEqual(['catch@35000', 'call@35500', 'turnEnd@35500']);
    expect(events[1]).toMatchObject({ call: 'timeViolation', player: 0 });
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 35500, reason: 'timeViolation' });
  });

  it('serve clock: expiry during the catch faults at that moment', () => {
    const t = tossed(28300);
    expect(tags(turnClock(t, 40000))).toEqual(['catch@32300', 'call@32500', 'turnEnd@32500']);
  });

  it('serve clock: expiry during the toss with a locked word is still a dropped ball', () => {
    const t = tossed(31000);
    turnInput(t, 'b', 31500);
    turnClock(t, 40000);
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 35000, reason: 'ballDropped' });
  });

  it('with serveClockMs null the clock never expires', () => {
    const t = started(createTurn(serveData({ serveClockMs: null })));
    expect(tags(turnClock(t, 200000))).toEqual(['preServe@2500']);
    expect(nextDeadline(t)).toBeNull();
  });

  it('ignores Space during the toss and letters in the lead-in and PRE_SERVE', () => {
    const t = started(createTurn(serveData()));
    expect(turnInput(t, 'b', 1000)).toEqual([]);
    expect(turnInput(t, 'toss', 2000)).toEqual([]);
    expect(t.phase).toBe('leadIn');
    turnClock(t, 2500);
    expect(turnInput(t, 'b', 2600)).toEqual([]);
    expect(t.prompts).toEqual([]);
    turnInput(t, 'toss', 3000);
    expect(turnInput(t, 'toss', 3100)).toEqual([]);
    expect(t.tossAt).toBe(3000);
    expect(t.prompts).toHaveLength(1);
    expect(t.log.filter((e) => e.k === 'toss')).toHaveLength(1);
  });

  it('ignores anything that is neither a letter nor toss', () => {
    const t = tossed(3000);
    for (const k of ['B', ' ', 'Enter', 'é', '1', '']) expect(turnInput(t, k, 3100)).toEqual([]);
    expect(t.prompts[0]!.typed).toBe(0);
    expect(t.prompts[0]!.wrongKeys).toBe(0);
  });
});

describe('return turn', () => {
  it('shows the chase prompt (locked on the striker\'s word) at 0 and the choice prompt at chase completion', () => {
    const t = createTurn(returnData());
    expect(startTurn(t)).toEqual([
      { turn: 8, τ: 0, type: 'turnStart', owner: 1, kind: 'return' },
      { turn: 8, τ: 0, type: 'promptShown', player: 1, prompt: 48, kind: 'chase' },
    ]);
    expect(t.phase).toBe('chase');
    expect(t.prompts[0]).toMatchObject({ id: 48, kind: 'chase', locked: 0, options: [opt('ball')], shownAt: 0 });
    expect(t.active).toBe(0);
    const events = type(t, 'ball', 100);
    expect(tags(events)).toEqual(['keyOk@100', 'keyOk@200', 'keyOk@300', 'keyOk@400', 'wordDone@400', 'promptShown@400']);
    expect(events.at(-1)).toMatchObject({ player: 1, prompt: 49, kind: 'choice' });
    expect(t.phase).toBe('choice');
    expect(t.active).toBe(1);
    expect(t.prompts[1]).toMatchObject({ id: 49, kind: 'choice', locked: null, options: CHOICE.map(opt), shownAt: 400 });
  });

  it('queued: both words done before T decide the strike now and play it at T', () => {
    const t = chased();
    expect(tags(type(t, 'drop', 600))).toEqual(['lock@600', 'keyOk@700', 'keyOk@800', 'keyOk@900', 'wordDone@900']);
    expect(t.phase).toBe('queued');
    expect(t.outcome?.kind).toBe('strike');
    expect(t.outcome?.endτ).toBe(3000);
    expect(t.ended).toBe(false);
    expect(tags(turnClock(t, 2999))).toEqual(['bounce@1800']);
    expect(t.ended).toBe(false);
    const end = turnClock(t, 3000);
    expect(tags(end)).toEqual(['strike@3000', 'power@3000', 'turnEnd@3000']);
    expect(t.ended).toBe(true);
    expect(t.phase).toBe('ended');

    const s = strikeOf(t);
    const v = speed(3 / 0.3);
    expect(s.τ).toBe(3000);
    expect(s.player).toBe(1);
    expect(s.word).toEqual(opt('drop'));
    expect(s.option).toBe(0);
    expect(s.stretch).toBe(false);
    expect(s.isServe).toBe(false);
    expect(s.v).toBeCloseTo(v, 12);
    expect(s.target).toEqual(rallyTargets(0, 1)[0]);
    expect(s.shot.outcome).toBe('in');
    expect(s.shot.sigma).toBeCloseTo(0.1, 12);
    expect(s.flight.p0).toEqual({ x: RALLY_IN.contact.x, y: RALLY_IN.contact.y, z: 1 });
    expect(s.flight.destEnd).toBe(0);
    expect(s.flight.isServe).toBe(false);
    // Rally T at n = data.n + 1 = 2: pace·rallyBase/v · place(easy) · P(2) (early-typing spec §3).
    expect(s.flight.T).toBeCloseTo((TUNING.flight.rallyBaseMs / v) * TUNING.flight.place.easy * TUNING.flight.pressure, 6);
    expect(s.kmh).toBe(Math.round((95 * v * 1.0) / TUNING.flight.pressure));
    expect(s.forehand).toBe(stanceFor(RALLY_IN.contact, 1, restSpot(1)).forehand);
    expect(end[0]).toEqual({
      turn: 8, τ: 3000, type: 'strike', player: 1, word: 'drop', tier: 'easy', kmh: s.kmh, isServe: false, stretch: false, forehand: s.forehand,
    });
  });

  it('uses the chosen option\'s target and tier', () => {
    const t = chased();
    type(t, 'crosscourt', 500, 50);
    turnClock(t, 3000);
    const s = strikeOf(t);
    expect(s.option).toBe(2);
    expect(s.word.tier).toBe('hard');
    expect(s.target).toEqual(rallyTargets(0, 1)[2]);
    expect(s.flight.T).toBeCloseTo((TUNING.flight.rallyBaseMs / s.v) * TUNING.flight.place.hard * TUNING.flight.pressure, 6);
  });

  it('stretch: completion in (T, T + grace] strikes at completion with v × 0.9 and σ + 0.5', () => {
    const t = chased();
    const events = type(t, 'drop', 2900);
    expect(tags(events)).toEqual(['bounce@1800', 'lock@2900', 'keyOk@3000', 'keyOk@3100', 'keyOk@3200', 'wordDone@3200', 'strike@3200', 'power@3200', 'turnEnd@3200']);
    const s = strikeOf(t);
    expect(t.outcome?.endτ).toBe(3200);
    expect(s.τ).toBe(3200);
    expect(s.stretch).toBe(true);
    expect(s.v).toBeCloseTo(speed(3 / 0.3) * 0.9, 12);
    expect(s.shot.sigma).toBeCloseTo(0.1 + 0.5, 12);
    expect(s.shot.pNet).toBeCloseTo(0.05, 12);
    expect(s.flight.p0).toEqual(ballAt(RALLY_IN, 3200));
  });

  it('R20: a stretch strike point far past the baseline is clamped to the court limits (tiny T)', () => {
    const tiny = flight({ T: 300, grace: 400 });
    const t = started(createTurn(returnData({ incoming: tiny })));
    type(t, 'ball', 10, 10);
    type(t, 'drop', 620, 10);
    const s = strikeOf(t);
    expect(s.stretch).toBe(true);
    const raw = ballAt(tiny, 650);
    expect(raw.y).toBeGreaterThan(11.885 + 1.2);
    expect(s.flight.p0.y).toBeCloseTo(11.885 + 1.2, 12);
    expect(Math.abs(s.flight.p0.x)).toBeLessThanOrEqual(5.8);
    expect(s.flight.p0.x).toBe(Math.max(-5.8, Math.min(5.8, raw.x)));
    expect(s.flight.p0.z).toBe(raw.z);
  });

  it('miss: nothing typed passes at T + grace; ACE only for a serve return with the chase incomplete', () => {
    const rally = started(createTurn(returnData()));
    turnClock(rally, 3399);
    expect(rally.ended).toBe(false);
    expect(tags(turnClock(rally, 3400))).toEqual(['turnEnd@3400']);
    expect(rally.outcome).toEqual({ kind: 'miss', endτ: 3400, ace: false });

    const serveReturn = started(createTurn(returnData({ incoming: SERVE_IN, isServeReturn: true, n: 0 })));
    turnClock(serveReturn, 5000);
    expect(serveReturn.outcome).toEqual({ kind: 'miss', endτ: 3400, ace: true });

    const chasedServe = chased({ incoming: SERVE_IN, isServeReturn: true, n: 0 });
    type(chasedServe, 'cro', 1000);
    turnClock(chasedServe, 5000);
    expect(chasedServe.outcome).toEqual({ kind: 'miss', endτ: 3400, ace: false });
  });

  it('bounce: an IN ball bounces at tBounce, in court', () => {
    const t = started(createTurn(returnData()));
    expect(turnClock(t, 2000)).toEqual([
      { turn: 8, τ: RALLY_IN.tBounce, type: 'bounce', at: RALLY_IN.landing, inCourt: true },
    ]);
  });

  it('OUT call: the call comes at tBounce even when both words were completed earlier', () => {
    const t = chased({ incoming: RALLY_OUT });
    type(t, 'drop', 600);
    expect(t.phase).toBe('queued');
    const events = turnClock(t, 5000);
    expect(events).toEqual([
      { turn: 8, τ: 1800, type: 'bounce', at: RALLY_OUT.landing, inCourt: false },
      { turn: 8, τ: 1800, type: 'call', call: 'out', player: 0 },
      { turn: 8, τ: 1800, type: 'turnEnd', endτ: 1800 },
    ]);
    expect(t.outcome).toEqual({ kind: 'call', endτ: 1800, call: 'out' });
    expect(t.phase).toBe('ended');
    expect(t.active).toBeNull();
  });

  it('OUT on a serve is called FAULT', () => {
    const t = started(createTurn(returnData({ incoming: SERVE_OUT, isServeReturn: true, n: 0 })));
    const events = turnClock(t, 5000);
    expect(events.find((e) => e.type === 'call')).toMatchObject({ τ: SERVE_OUT.tBounce, call: 'fault', player: 0 });
    expect(t.outcome).toEqual({ kind: 'call', endτ: SERVE_OUT.tBounce, call: 'out' });
  });

  it('NET call at netT, with a netHit and no bounce', () => {
    const netT = RALLY_NET.netT!;
    expect(netT).toBeGreaterThan(0);
    expect(netT).toBeLessThan(RALLY_NET.tBounce);
    const t = chased({ incoming: RALLY_NET });
    expect(turnClock(t, 5000)).toEqual([
      { turn: 8, τ: netT, type: 'netHit' },
      { turn: 8, τ: netT, type: 'call', call: 'net', player: 0 },
      { turn: 8, τ: netT, type: 'turnEnd', endτ: netT },
    ]);
    expect(t.outcome).toEqual({ kind: 'call', endτ: netT, call: 'net' });
  });

  it('a NET ball that never crosses the net plane is called at the bounce time, without a bounce', () => {
    const short = flight({ landing: { x: 1, y: -5 }, outcome: 'net' });
    expect(short.netT).toBe(short.tBounce);
    const t = started(createTurn(returnData({ incoming: short })));
    expect(tags(turnClock(t, 5000))).toEqual([`netHit@${short.tBounce}`, `call@${short.tBounce}`, `turnEnd@${short.tBounce}`]);
  });

  it('NET on a serve is called FAULT', () => {
    const t = started(createTurn(returnData({ incoming: SERVE_NET, isServeReturn: true, n: 0 })));
    const events = turnClock(t, 5000);
    expect(events.find((e) => e.type === 'call')).toMatchObject({ τ: SERVE_NET.netT, call: 'fault', player: 0 });
  });

  it('keys typed after the call are ignored', () => {
    const t = chased({ incoming: RALLY_OUT });
    turnClock(t, 1800);
    expect(turnInput(t, 'd', 1900)).toEqual([]);
    expect(t.prompts[1]!.typed).toBe(0);
  });

  it('ignores toss in a return turn', () => {
    const t = started(createTurn(returnData()));
    expect(turnInput(t, 'toss', 100)).toEqual([]);
  });
});

describe('deadline ordering', () => {
  it('a serve key at exactly tossAt + 2a counts (strike with contact factor 0.85, not a dropped ball)', () => {
    const t = tossed(3000);
    type(t, 'ball', 6700);
    const s = strikeOf(t);
    expect(s.τ).toBe(7000);
    expect(s.v).toBeCloseTo(speed(3 / 0.3) * 0.85, 12);
  });

  it('a toss at exactly the serve clock expiry counts', () => {
    const t = started(createTurn(serveData()));
    turnClock(t, 32499);
    expect(tags(turnInput(t, 'toss', 32500))).toEqual(['toss@32500', 'promptShown@32500']);
    expect(turnClock(t, 32500)).toEqual([]);
    expect(t.outcome).toBeNull();
  });

  it('a choice completed at exactly T is queued, and ends only when the clock confirms T', () => {
    const t = chased();
    type(t, 'drop', 2700);
    expect(t.phase).toBe('queued');
    expect(t.outcome?.endτ).toBe(3000);
    expect(t.ended).toBe(false);
    expect(nextDeadline(t)).toBe(3000);
    expect(tags(turnClock(t, 3000))).toEqual(['strike@3000', 'power@3000', 'turnEnd@3000']);
    expect(strikeOf(t).stretch).toBe(false);
  });

  it('a choice completed at exactly T + grace is a stretch strike, not a miss', () => {
    const t = chased();
    type(t, 'drop', 3100);
    expect(strikeOf(t).τ).toBe(3400);
    expect(strikeOf(t).stretch).toBe(true);
  });

  it('a key after a passed deadline comes too late: the deadline is processed first', () => {
    const t = tossed(3000);
    type(t, 'bal', 6700);
    const events = turnInput(t, 'l', 7001);
    expect(tags(events)).toEqual(['call@7000', 'turnEnd@7000']);
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 7000, reason: 'ballDropped' });
  });
});

describe('training freeze', () => {
  it('serve: a 5 s pause before the first key shifts the toss deadline by 5 s', () => {
    const t = tossed(3000, { freezeFirst: true });
    expect(t.freezeSince).toBe(3000);
    expect(t.seenKinds).toEqual(['serve']);
    expect(nextDeadline(t)).toBeNull();
    expect(turnClock(t, 7500)).toEqual([]);
    expect(simTime(t, 7500)).toBe(3000);
    expect(turnInput(t, 'x', 7600)).toEqual([]);
    expect(t.freezeSince).toBe(3000);
    turnInput(t, 'b', 8000);
    expect(t.freezeSince).toBeNull();
    expect(t.frozenMs).toBe(5000);
    expect(simTime(t, 9000)).toBe(4000);
    expect(nextDeadline(t)).toBe(12000);
    expect(turnClock(t, 11999)).toEqual([]);
    expect(tags(turnClock(t, 12000))).toEqual(['call@12000', 'turnEnd@12000']);
    expect(t.log.filter((e) => e.k === 'freeze')).toEqual([
      { τ: 3000, k: 'freeze', on: true },
      { τ: 8000, k: 'freeze', on: false },
    ]);
  });

  it('serve: the toss timing seen by the strike excludes the freeze', () => {
    const t = tossed(3000, { freezeFirst: true });
    type(t, 'ball', 8000);
    const s = strikeOf(t);
    expect(s.τ).toBe(8300);
    // 300 ms of unfrozen toss time: still before the apex.
    expect(s.v).toBeCloseTo(speed(3 / 0.3), 12);
    expect(s.flight.p0.z).toBeCloseTo(1.8 + 1.4 * (1 - 0.85 * 0.85), 12);
  });

  it('return: a 5 s pause before the first chase key shifts the bounce and the pass by 5 s', () => {
    const t = started(createTurn(returnData({ freezeFirst: true })));
    expect(t.freezeSince).toBe(0);
    expect(turnClock(t, 4000)).toEqual([]);
    turnInput(t, 'b', 5000);
    expect(nextDeadline(t)).toBe(6800);
    expect(tags(turnClock(t, 8399))).toEqual(['bounce@6800']);
    expect(tags(turnClock(t, 8400))).toEqual(['turnEnd@8400']);
    expect(t.outcome).toEqual({ kind: 'miss', endτ: 8400, ace: false });
  });

  it('serve: a short serve clock stands still while frozen and resumes shifted by the frozen time', () => {
    // A serve freeze ends only with a lock, and a locked toss ends in a strike or a dropped ball
    // whatever the clock says, so the shifted expiry is checked on the clock itself.
    const data = serveData({ freezeFirst: true, serveClockMs: 1000 });
    const t = started(createTurn(data));
    turnClock(t, 3000);
    turnInput(t, 'toss', 3000);
    expect(turnClock(t, 7500)).toEqual([]);
    turnInput(t, 'b', 8000);
    expect(t.frozenMs).toBe(5000);
    expect(serveClockτ(t, data)).toBe(2500 + 1000 + 5000);
    type(t, 'all', 8100);
    expect(strikeOf(t).τ).toBe(8300);
  });

  it('return: a stretch strike after freezes is struck from the ball at the unfrozen simulation time', () => {
    const t = started(createTurn(returnData({ freezeFirst: true })));
    type(t, 'ball', 1000);
    turnInput(t, 'd', 2300);
    expect(t.frozenMs).toBe(2000);
    // Frozen 0 → 1000 (chase) and 1300 → 2300 (choice): T falls at 5000 and the grace ends at 5400.
    type(t, 'rop', 5100);
    const s = strikeOf(t);
    expect(s.τ).toBe(5300);
    expect(s.stretch).toBe(true);
    expect(s.flight.p0).toEqual(ballAt(RALLY_IN, 3300));
  });

  it('return: an OUT ball is called at its bounce shifted by the frozen time', () => {
    const t = started(createTurn(returnData({ incoming: RALLY_OUT, freezeFirst: true })));
    expect(turnClock(t, 4000)).toEqual([]);
    turnInput(t, 'b', 5000);
    expect(nextDeadline(t)).toBe(6800);
    expect(turnClock(t, 6799)).toEqual([]);
    expect(turnClock(t, 6800)).toEqual([
      { turn: 8, τ: 6800, type: 'bounce', at: RALLY_OUT.landing, inCourt: false },
      { turn: 8, τ: 6800, type: 'call', call: 'out', player: 0 },
      { turn: 8, τ: 6800, type: 'turnEnd', endτ: 6800 },
    ]);
    expect(t.outcome).toEqual({ kind: 'call', endτ: 6800, call: 'out' });
  });

  it('return: the choice prompt freezes again; a queued strike lands at T + all frozen time', () => {
    const t = started(createTurn(returnData({ freezeFirst: true })));
    type(t, 'ball', 1000);
    expect(t.frozenMs).toBe(1000);
    expect(t.freezeSince).toBe(1300);
    expect(t.seenKinds).toEqual(['chase', 'choice']);
    type(t, 'drop', 2300);
    expect(t.frozenMs).toBe(2000);
    expect(t.outcome?.endτ).toBe(5000);
    expect(tags(turnClock(t, 5000))).toEqual(['bounce@3800', 'strike@5000', 'power@5000', 'turnEnd@5000']);
  });

  it('does not freeze for kinds already seen or without freezeFirst', () => {
    const seen = createTurn(returnData({ freezeFirst: true }));
    seen.seenKinds = ['chase'];
    startTurn(seen);
    expect(seen.freezeSince).toBeNull();
    const plain = started(createTurn(returnData()));
    expect(plain.freezeSince).toBeNull();
    expect(plain.seenKinds).toEqual(['chase']);
  });
});

describe('clock semantics', () => {
  it('idempotence: turnClock twice with the same τ emits nothing new', () => {
    const t = chased();
    expect(tags(turnClock(t, 1800))).toEqual(['bounce@1800']);
    expect(turnClock(t, 1800)).toEqual([]);
    const s = tossed(3000);
    expect(tags(turnClock(s, 7000))).toEqual(['catch@7000']);
    expect(turnClock(s, 7000)).toEqual([]);
  });

  it('an input at a deadline leaves it pending for the next clock, which fires it once', () => {
    const t = tossed(3000);
    expect(turnInput(t, 'z', 7000)).toEqual([]);
    expect(nextDeadline(t)).toBe(7000);
    expect(tags(turnClock(t, 7000))).toEqual(['catch@7000']);
    expect(turnClock(t, 7000)).toEqual([]);
  });

  it('a bounce at the τ of an input is emitted once', () => {
    const t = chased();
    expect(tags(turnInput(t, 'd', 1800))).toEqual(['bounce@1800', 'lock@1800']);
    expect(turnClock(t, 1800)).toEqual([]);
    expect(turnInput(t, 'r', 1800)).toEqual([{ turn: 8, τ: 1800, type: 'keyOk', player: 1, prompt: 49 }]);
  });

  it('a bounce that fired just before a freeze is not replayed after it (float-exact)', () => {
    // Chase freeze 0 → 123.456; the chase completes exactly when the bounce is due, which starts the
    // choice freeze; that freeze ends at 1929.376, where 1800 + frozenMs rounds above the key's τ.
    const t = started(createTurn(returnData({ freezeFirst: true })));
    const s = RALLY_IN.tBounce + 123.456;
    const e = 1929.376;
    turnInput(t, 'b', 123.456);
    turnInput(t, 'a', 1000);
    turnInput(t, 'l', 1500);
    const events = turnInput(t, 'l', s);
    expect(tags(events)).toEqual([`bounce@${s}`, `keyOk@${s}`, `wordDone@${s}`, `promptShown@${s}`]);
    expect(t.freezeSince).toBe(s);
    events.push(...turnInput(t, 'd', e), ...turnClock(t, e + 1), ...turnClock(t, 9000));
    expect(RALLY_IN.tBounce + t.frozenMs).toBeGreaterThan(e);
    expect(events.filter((ev) => ev.type === 'bounce')).toHaveLength(1);
    expect(t.outcome?.kind).toBe('miss');
  });

  it('nextDeadline never returns a τ before the latest processed τ (a deadline tie at a freeze start)', () => {
    // The chase completes exactly when the OUT call is due, which starts the choice freeze; that
    // freeze ends at 2312.1, where callT + frozenMs rounds one ulp below the key's τ.
    const t = started(createTurn(returnData({ incoming: RALLY_OUT, freezeFirst: true })));
    const s = RALLY_OUT.tBounce + 333.3;
    const e = 2312.1;
    turnInput(t, 'b', 333.3);
    turnInput(t, 'a', 1000);
    turnInput(t, 'l', 1500);
    expect(tags(turnInput(t, 'l', s))).toEqual([`bounce@${s}`, `keyOk@${s}`, `wordDone@${s}`, `promptShown@${s}`]);
    expect(t.freezeSince).toBe(s);
    turnInput(t, 'd', e);
    expect(RALLY_OUT.tBounce + t.frozenMs).toBeLessThan(e);
    expect(nextDeadline(t)).toBe(e);
    expect(tags(turnClock(t, nextDeadline(t)!))).toEqual([`call@${e}`, `turnEnd@${e}`]);
    expect(t.outcome).toEqual({ kind: 'call', endτ: e, call: 'out' });
  });

  it('a stale input is applied at the latest processed τ', () => {
    const t = tossed(3000);
    turnClock(t, 5000);
    expect(turnInput(t, 'b', 4000)).toEqual([{ turn: 7, τ: 5000, type: 'lock', player: 0, prompt: 40, option: 0 }]);
    expect(t.prompts[0]!.tFirst).toBe(5000);
    expect(t.τ).toBe(5000);
    expect(turnClock(t, 4500)).toEqual([]);
    expect(t.τ).toBe(5000);
  });

  it('inputs and clocks before startTurn or after the end are ignored', () => {
    const t = createTurn(serveData({ leadIn: { kind: 'none', ms: 0, text: [] } }));
    expect(turnInput(t, 'toss', 100)).toEqual([]);
    expect(turnClock(t, 100)).toEqual([]);
    expect(t.phase).toBe('leadIn');
    expect(nextDeadline(t)).toBeNull();
    expect(tags(startTurn(t))).toEqual(['turnStart@0', 'preServe@0']);
    expect(startTurn(t)).toEqual([]);
    turnInput(t, 'toss', 100);
    type(t, 'ball', 200);
    expect(t.ended).toBe(true);
    const snapshot = JSON.stringify(t);
    expect(turnInput(t, 'v', 900)).toEqual([]);
    expect(turnClock(t, 90000)).toEqual([]);
    expect(nextDeadline(t)).toBeNull();
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it('ignores a non-finite τ', () => {
    const t = tossed(3000);
    expect(turnInput(t, 'b', Number.NaN)).toEqual([]);
    expect(turnClock(t, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(t.τ).toBe(3000);
  });

  it('nextDeadline walks the pending deadlines in turn-clock τ', () => {
    const s = started(createTurn(serveData()));
    expect(nextDeadline(s)).toBe(2500);
    turnClock(s, 2500);
    expect(nextDeadline(s)).toBe(32500);
    turnInput(s, 'toss', 3000);
    expect(nextDeadline(s)).toBe(7000);
    turnClock(s, 7000);
    expect(nextDeadline(s)).toBe(7500);

    const r = started(createTurn(returnData()));
    expect(nextDeadline(r)).toBe(1800);
    turnClock(r, 1800);
    expect(nextDeadline(r)).toBe(3400);
    const net = started(createTurn(returnData({ incoming: RALLY_NET })));
    expect(nextDeadline(net)).toBe(RALLY_NET.netT);
  });

  it('stamps every event with the turn id and a finite τ', () => {
    const t = chased();
    const events = [...type(t, 'volley', 500), ...turnClock(t, 4000)];
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) {
      expect(e.turn).toBe(8);
      expect(Number.isFinite(e.τ)).toBe(true);
    }
  });
});

describe('turn state', () => {
  it('createTurn copies its start data', () => {
    const data = serveData();
    const t = createTurn(data);
    data.wordSets[0]!.options[0]!.word = 'zzz';
    data.wordSets.push(serveSet(SET_C));
    expect(wordSetsOf(t)).toHaveLength(2);
    expect(wordSetsOf(t)[0]!.options[0]!.word).toBe('ball');
    const extra = serveSet(SET_C);
    appendWordSet(t, extra);
    extra.options[0]!.word = 'zzz';
    expect(wordSetsOf(t)[2]!.options[0]!.word).toBe('net');
  });

  it('createTurn starts with empty typing state', () => {
    expect(createTurn(returnData())).toEqual({
      data: returnData(),
      started: false,
      τ: 0,
      phase: 'chase',
      prompts: [],
      active: null,
      tossAt: null,
      catchAt: null,
      setIndex: 0,
      frozenMs: 0,
      freezeSince: null,
      seenKinds: [],
      log: [],
      outcome: null,
      ended: false,
    });
  });

  it('appendWordSet leaves return turns alone', () => {
    const t = createTurn(returnData());
    appendWordSet(t, serveSet(SET_C));
    expect(t.data).toEqual(returnData());
  });

  it('stays plain JSON-safe data through a scripted serve and return', () => {
    const s = tossed(3000);
    type(s, 'tiebreaker', 3100, 90);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const r = chased({ incoming: strikeOf(s).flight, striker: 0, isServeReturn: true, n: 0 });
    type(r, 'volley', 500);
    turnClock(r, 20000);
    expect(r.ended).toBe(true);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('is deterministic: the same script gives the same state and events', () => {
    const run = (): string => {
      const t = tossed(3000);
      const events = [...type(t, 'vxolley', 3200, 70), ...turnClock(t, 9000)];
      return JSON.stringify({ t, events });
    };
    expect(run()).toBe(run());
  });

  it('logs every typing step for playback', () => {
    const t = tossed(3000);
    turnInput(t, 'b', 3400);
    turnInput(t, 'x', 3450);
    type(t, 'all', 3500);
    expect(t.log).toEqual([
      { τ: 3000, k: 'toss' },
      { τ: 3000, k: 'show', prompt: 40 },
      { τ: 3400, k: 'lock', prompt: 40, option: 0, ch: 'b' },
      { τ: 3450, k: 'bad', prompt: 40, ch: 'x' },
      { τ: 3500, k: 'ok', prompt: 40, ch: 'a' },
      { τ: 3600, k: 'ok', prompt: 40, ch: 'l' },
      { τ: 3700, k: 'ok', prompt: 40, ch: 'l' },
      { τ: 3700, k: 'done', prompt: 40 },
    ]);
  });

  it('keeps the serve target from the tossed set', () => {
    const t = started(createTurn(serveData({ wordSets: [serveSet(SET_A, 'wide')] })));
    turnClock(t, 2500);
    turnInput(t, 'toss', 3000);
    type(t, 'tiebreaker', 3100, 50);
    const target: Vec2 = serveTargets(1, 'deuce', 'wide')[2]!;
    expect(strikeOf(t).target).toEqual(target);
  });
});

describe('power meter in the turn runner (power-meter spec §4)', () => {
  const typeAt = (t: TurnState, word: string, from: number, gap = 100): GameEvent[] =>
    [...word].flatMap((ch, i) => turnInput(t, ch, from + i * gap));
  const powerEvents = (events: GameEvent[]) => events.filter((e) => e.type === 'power');

  it('a full meter and a clean chase: the choice shows 4 options, and the insane word strikes at its target', () => {
    const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(t);
    typeAt(t, 'ball', 100);
    expect(t.prompts[1]!.options.map((o) => o.word)).toEqual(CHOICE_4.options.map((o) => o.word));
    const events = typeAt(t, INSANE_WORD, 600);
    events.push(...turnClock(t, 3000));
    expect(t.outcome?.kind).toBe('strike');
    if (t.outcome?.kind !== 'strike') return;
    expect(t.outcome.strike.word.tier).toBe('insane');
    expect(t.outcome.strike.target).toEqual(CHOICE_4.targets[3]);
    expect(powerEvents(events)).toEqual([]); // 4 stays 4
  });

  it('a wrong key in the chase empties the meter at once and the choice shows 3 options', () => {
    const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(t);
    const events = typeAt(t, 'bzall', 100);
    expect(powerEvents(events)).toEqual([{ turn: 8, τ: 200, type: 'power', player: 1, from: 4, to: 0 }]);
    expect(t.prompts[1]!.options).toHaveLength(3);
  });

  it('a flawless queued choice fills the meter by one at contact, after the strike event', () => {
    const t = createTurn(returnData({ power: 2 }));
    startTurn(t);
    const events = [...typeAt(t, 'ball', 100), ...typeAt(t, 'drop', 600), ...turnClock(t, 3000)];
    const types = events.filter((e) => ['strike', 'power', 'turnEnd'].includes(e.type)).map((e) => e.type);
    expect(types).toEqual(['strike', 'power', 'turnEnd']);
    expect(powerEvents(events)).toEqual([{ turn: 8, τ: 3000, type: 'power', player: 1, from: 2, to: 3 }]);
  });

  it('an OUT call cancels the turn: no fill, but a wrong key before it still empties the meter', () => {
    const clean = createTurn(returnData({ power: 2, incoming: RALLY_OUT }));
    startTurn(clean);
    const cleanEvents = [...typeAt(clean, 'ball', 100), ...typeAt(clean, 'drop', 600), ...turnClock(clean, 3500)];
    expect(clean.outcome?.kind).toBe('call');
    expect(powerEvents(cleanEvents)).toEqual([]);
    const slipped = createTurn(returnData({ power: 2, incoming: RALLY_OUT }));
    startTurn(slipped);
    const slipEvents = [...typeAt(slipped, 'bzall', 100), ...turnClock(slipped, 3500)];
    expect(powerEvents(slipEvents)).toEqual([{ turn: 8, τ: 200, type: 'power', player: 1, from: 2, to: 0 }]);
  });

  it('a full-meter serve offers 4 words; the insane word strikes at the insane box target', () => {
    const t = createTurn(serveData({ power: 4, wordSets: [serveSet([...SET_A, 'quarterfinalist']), serveSet([...SET_B, INSANE_WORD], 'wide')] }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    expect(t.prompts[0]!.options).toHaveLength(4);
    typeAt(t, 'quarterfinalist', 2700);
    expect(t.outcome?.kind).toBe('strike');
    if (t.outcome?.kind !== 'strike') return;
    expect(t.outcome.strike.target).toEqual(t.data.kind === 'serve' ? t.data.wordSets[0]!.targets[3] : null);
  });

  it('an insane serve flight uses placeServeInsane; easy/medium/hard serves stay at place 1', () => {
    const insane = createTurn(
      serveData({ power: 4, wordSets: [serveSet([...SET_A, 'quarterfinalist']), serveSet([...SET_B, INSANE_WORD], 'wide')] }),
    );
    startTurn(insane);
    turnInput(insane, 'toss', 2600);
    typeAt(insane, 'quarterfinalist', 2700);
    const s = strikeOf(insane);
    expect(s.word.tier).toBe('insane');
    expect(s.flight.T).toBeCloseTo(
      flightTimeMs({ pace: insane.data.pace, chaseLen: s.word.len, v: s.v, tier: 'insane', isServe: true, n: 0 }),
      9,
    );
    const base = (insane.data.pace * (TUNING.flight.baseMs + TUNING.flight.perCharMs * s.word.len)) / s.v;
    const allowance = TUNING.flight.serveReturnBonusMs + TUNING.flight.serveReturnBonusPaceMs * insane.data.pace;
    expect(s.flight.T).toBeCloseTo(base * TUNING.flight.placeServeInsane + allowance, 9);
    expect(s.flight.T).not.toBeCloseTo(base * TUNING.flight.place.insane + allowance, 5);

    const easy = tossed(3000);
    type(easy, 'ball', 3400);
    const e = strikeOf(easy);
    expect(e.word.tier).toBe('easy');
    expect(e.flight.T).toBeCloseTo(
      flightTimeMs({ pace: easy.data.pace, chaseLen: e.word.len, v: e.v, tier: 'easy', isServe: true, n: 0 }),
      9,
    );
    const easyBase = (easy.data.pace * (TUNING.flight.baseMs + TUNING.flight.perCharMs * e.word.len)) / e.v;
    expect(e.flight.T).toBeCloseTo(easyBase * 1 + allowance, 9);
  });

  it('a slip in a serve word empties the meter but the serve still strikes', () => {
    const t = createTurn(serveData({ power: 3 }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    const events = typeAt(t, 'bzall', 2700);
    expect(powerEvents(events)).toEqual([{ turn: 7, τ: 2800, type: 'power', player: 0, from: 3, to: 0 }]);
    expect(t.outcome?.kind).toBe('strike');
  });

  it('with the meter off (training) there are no power events', () => {
    const t = createTurn(returnData({ power: null }));
    startTurn(t);
    const events = [...typeAt(t, 'bzall', 100), ...typeAt(t, 'drop', 700), ...turnClock(t, 3000)];
    expect(powerEvents(events)).toEqual([]);
    expect(t.prompts[1]!.options).toHaveLength(3);
  });
});

describe('early typing (early-typing spec §2)', () => {
  const EARLY = (): ReturnTurnData => returnData({ earlyFrom: -1000 }); // chase 'ball', choice drop / volley / crosscourt

  it('shows the chase at earlyFrom and applies early keys at their own τ before τ 0', () => {
    const t = createTurn(EARLY());
    const events = startTurn(t, [{ key: 'b', τ: -600 }, { key: 'a', τ: -500 }]);
    const chase = t.prompts[0]!;
    expect(chase.shownAt).toBe(-1000);
    expect([chase.typed, chase.tFirst, chase.tLast]).toEqual([2, -600, -500]);
    expect(tags(events)).toEqual(['turnStart@0', 'promptShown@-1000', 'keyOk@-600', 'keyOk@-500']);
    expect(t.phase).toBe('chase');
    type(t, 'll', 100);
    expect(chase.completedAt).toBe(200);
    expect(t.prompts[1]?.shownAt).toBe(200);
  });

  it('a chase finished before the strike shows the choice at τ 0, and later early keys never reach it', () => {
    const t = createTurn(EARLY());
    startTurn(t, [...'balldr'].map((key, i) => ({ key, τ: -900 + 100 * i })));
    const [chase, choice] = t.prompts;
    expect(chase?.completedAt).toBe(-600);
    expect(choice?.shownAt).toBe(0);
    expect([choice?.locked, choice?.typed]).toEqual([null, 0]);
    expect(t.phase).toBe('choice');
  });

  it('an early wrong key is a slip that empties the meter at its τ', () => {
    const t = createTurn(returnData({ earlyFrom: -1000, power: 3 }));
    const events = startTurn(t, [{ key: 'b', τ: -800 }, { key: 'x', τ: -700 }, { key: 'a', τ: -600 }]);
    expect(t.prompts[0]).toMatchObject({ slips: 1, wrongKeys: 1, typed: 2 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'power', from: 3, to: 0, τ: -700 }));
  });

  it.each([
    ['a key before earlyFrom', [{ key: 'b', τ: -1001 }]],
    ['a key after the strike', [{ key: 'b', τ: 1 }]],
    ['keys out of order', [{ key: 'b', τ: -500 }, { key: 'a', τ: -600 }]],
    ['a non-letter', [{ key: 'toss', τ: -500 }]],
    ['a non-finite τ', [{ key: 'b', τ: Number.NaN }]],
    ['more than MAX_EARLY_KEYS keys', Array.from({ length: MAX_EARLY_KEYS + 1 }, (_, i) => ({ key: 'z', τ: -900 + i }))],
  ])('ignores the whole list with %s', (_name, early) => {
    const t = createTurn(EARLY());
    startTurn(t, early);
    expect(t.prompts[0]).toMatchObject({ typed: 0, wrongKeys: 0, shownAt: -1000 });
  });

  it('takes no early keys on a serve return', () => {
    const t = createTurn(returnData({ isServeReturn: true, earlyFrom: null, n: 0 }));
    startTurn(t, [{ key: 'b', τ: -100 }]);
    expect(t.prompts[0]).toMatchObject({ typed: 0, shownAt: 0 });
  });

  it('training: a chase shown early freezes from τ 0, and not at all once early keys came', () => {
    const frozen = createTurn(returnData({ earlyFrom: -1000, freezeFirst: true }));
    startTurn(frozen);
    expect(frozen.freezeSince).toBe(0);
    const typed = createTurn(returnData({ earlyFrom: -1000, freezeFirst: true }));
    startTurn(typed, [{ key: 'b', τ: -500 }]);
    expect(typed.freezeSince).toBeNull();
    expect(typed.seenKinds).toContain('chase');
  });
});
