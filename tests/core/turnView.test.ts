import { describe, expect, it } from 'vitest';
import { rallyTargets } from '../../src/core/court';
import { createTurn, simTime, startTurn, turnClock, turnInput } from '../../src/core/turn';
import { type TurnView, turnViewAt } from '../../src/core/turnView';
import type { ReturnTurnData, ServeTurnData, TurnData, TurnState, WordOption } from '../../src/core/types';
import { progress } from '../../src/core/typing';
import { CHOICE, opt, RALLY_OUT, returnData, SET_A, SET_B, serveData, serveSet } from './turnFixtures';

/** Player 1's second serve to player 0 from the ad side, after a 1.5 s fault call. */
const secondServe = (over: Partial<ServeTurnData> = {}): ServeTurnData =>
  serveData({
    turnId: 3,
    promptBase: 16,
    owner: 1,
    receiver: 0,
    serveNo: 2,
    side: 'ad',
    leadIn: { kind: 'fault', ms: 1500, text: ['FAULT', 'OUT'] },
    wordSets: [serveSet(SET_A, 'T', 0, 'ad'), serveSet(SET_B, 'wide', 0, 'ad')],
    ...over,
  });

/** Player 1 returning a rally ball, with the choice targets mirrored (m = −1). */
const rallyReturn = (over: Partial<ReturnTurnData> = {}): ReturnTurnData =>
  returnData({
    turnId: 4,
    promptBase: 24,
    choice: { options: CHOICE.map(opt), targets: rallyTargets(0, -1), m: -1 },
    ...over,
  });

/** One scripted moment: an owner key at τ (or only a clock confirmation when `key` is absent). */
interface Step {
  τ: number;
  key?: string;
}

/** What the live runner shows at τ once everything up to τ has been processed, in TurnView shape. */
function liveView(t: TurnState, τ: number): TurnView {
  const chase = t.data.kind === 'return' ? t.prompts[0] : undefined;
  const outcome = t.ended ? t.outcome : null;
  const view: TurnView = {
    phase: t.phase,
    τ,
    simτ: simTime(t, τ),
    prompts: t.prompts.map((p) => ({
      id: p.id,
      kind: p.kind,
      options: p.options,
      locked: p.locked,
      typed: p.typed,
      lastWrongAt: p.lastWrongAt,
      completedAt: p.completedAt,
      shownAt: p.shownAt,
    })),
    active: t.active,
    tossAt: t.tossAt,
    catchAt: t.catchAt,
    chaseProgress: chase === undefined ? 0 : progress(chase),
    strike: outcome?.kind === 'strike' ? outcome.strike : null,
    outcome,
  };
  return JSON.parse(JSON.stringify(view)) as TurnView;
}

/** Runs the script, confirming the clock at every step and capturing the live view there. */
function run(data: TurnData, steps: Step[]): { t: TurnState; captured: TurnView[] } {
  const t = createTurn(data);
  startTurn(t);
  const captured = [liveView(t, 0)];
  for (const { τ, key } of steps) {
    if (key !== undefined) turnInput(t, key, τ);
    turnClock(t, τ);
    captured.push(liveView(t, τ));
  }
  return { t, captured };
}

const keys = (word: string, from: number, step = 100): Step[] => [...word].map((key, i) => ({ τ: from + i * step, key }));
const at = (...τs: number[]): Step[] => τs.map((τ) => ({ τ }));

const hide = (o: WordOption): WordOption => ({ word: '', len: o.len, tier: o.tier, hidden: true });

/** The turn as the other player receives it (Task 10 redaction): serve words hidden, letters starred. */
function redacted(t: TurnState): TurnState {
  const r = JSON.parse(JSON.stringify(t)) as TurnState;
  if (r.data.kind === 'serve') {
    r.data.wordSets = r.data.wordSets.map((s) => ({ ...s, options: s.options.map(hide), targets: [] }));
  }
  r.prompts = r.prompts.map((p) => (p.kind === 'serve' ? { ...p, options: p.options.map(hide) } : p));
  r.log = r.log.map((e) => ('ch' in e ? { ...e, ch: '*' } : e));
  return r;
}

/** Wipes the prompts' live typing state, leaving only what was shown: the view must rebuild it from the log. */
function wiped(t: TurnState): TurnState {
  const r = JSON.parse(JSON.stringify(t)) as TurnState;
  r.prompts = r.prompts.map((p) => ({
    ...p,
    locked: null,
    typed: 0,
    correctKeys: 0,
    wrongKeys: 0,
    slips: 0,
    inSlip: false,
    tFirst: null,
    tLast: null,
    completedAt: null,
    lastWrongAt: null,
  }));
  return r;
}

function expectReplayMatches(data: TurnData, steps: Step[]): TurnState {
  const { t, captured } = run(data, steps);
  expect(captured.length).toBe(steps.length + 1);
  for (const live of captured) {
    expect(turnViewAt(t, live.τ)).toEqual(live);
    expect(turnViewAt(wiped(t), live.τ)).toEqual(live);
    const hidden = { ...live, prompts: live.prompts.map((p) => (p.kind === 'serve' ? { ...p, options: p.options.map(hide) } : p)) };
    expect(turnViewAt(redacted(t), live.τ)).toEqual(hidden);
  }
  return t;
}

describe('turnViewAt', () => {
  it('replays a serve turn with a catch, a re-toss, a wrong key and a strike', () => {
    const t = expectReplayMatches(secondServe(), [
      ...at(1000, 1500, 2000),
      { τ: 3000, key: 'toss' },
      ...at(4000, 6999, 7000, 7200, 7499, 7500),
      { τ: 8000, key: 'toss' },
      { τ: 8400, key: 'a' },
      { τ: 8500, key: 'x' },
      { τ: 8550, key: 'y' },
      { τ: 8600, key: 'c' },
      { τ: 8700, key: 'e' },
      ...at(9000),
    ]);
    expect(t.outcome?.kind).toBe('strike');
    const view = turnViewAt(t, 8650);
    expect(view.phase).toBe('toss');
    expect(view.prompts).toHaveLength(2);
    expect(view.prompts[1]).toMatchObject({ id: 17, locked: 0, typed: 2, lastWrongAt: 8550, completedAt: null });
    expect(view.active).toBe(1);
    expect(view.strike).toBeNull();
    expect(turnViewAt(t, 8699).strike).toBeNull();
    expect(turnViewAt(t, 8700).strike).toEqual(t.outcome?.kind === 'strike' ? t.outcome.strike : 'no strike');
  });

  it('replays a time violation at the catch end, keeping the toss and catch times', () => {
    const t = expectReplayMatches(secondServe(), [{ τ: 29000, key: 'toss' }, ...at(33000, 33400, 33500, 34000)]);
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 33500, reason: 'timeViolation' });
    expect(turnViewAt(t, 34000)).toMatchObject({ phase: 'ended', tossAt: 29000, catchAt: 33000 });
  });

  it('replays a training freeze and a dropped ball, with simτ standing still while frozen', () => {
    const t = expectReplayMatches(secondServe({ freezeFirst: true }), [
      ...at(1500),
      { τ: 3000, key: 'toss' },
      ...at(4000, 5000),
      { τ: 6000, key: 'v' },
      { τ: 6100, key: 'o' },
      ...at(8000, 9999, 10000, 11000),
    ]);
    expect(t.outcome).toEqual({ kind: 'fault', endτ: 10000, reason: 'ballDropped' });
    expect(turnViewAt(t, 5000).simτ).toBe(3000);
    expect(turnViewAt(t, 8000).simτ).toBe(5000);
  });

  it('replays a return turn: chase with a wrong key, choice, queued strike at T', () => {
    const t = expectReplayMatches(rallyReturn(), [
      { τ: 100, key: 'b' },
      { τ: 150, key: 'q' },
      { τ: 200, key: 'a' },
      ...keys('ll', 300),
      ...at(450),
      ...keys('volley', 600),
      ...at(1200, 1799, 1800, 2999, 3000, 3500),
    ]);
    expect(t.outcome?.kind).toBe('strike');
    const view = turnViewAt(t, 250);
    expect(view.phase).toBe('chase');
    expect(view.chaseProgress).toBe(0.5);
    expect(view.prompts[0]).toMatchObject({ id: 24, kind: 'chase', locked: 0, typed: 2, lastWrongAt: 150 });
    const queued = turnViewAt(t, 2000);
    expect(queued.phase).toBe('queued');
    expect(queued.outcome).toBeNull();
    expect(queued.strike).toBeNull();
    expect(queued.active).toBe(1);
    expect(turnViewAt(t, 3000).outcome).toEqual(t.outcome);
  });

  it('replays an OUT call that overrides a queued strike', () => {
    const t = expectReplayMatches(rallyReturn({ incoming: RALLY_OUT }), [
      ...keys('ball', 100),
      ...keys('drop', 600),
      ...at(1000, 1799, 1800, 2500),
    ]);
    expect(t.outcome).toEqual({ kind: 'call', endτ: 1800, call: 'out' });
    expect(turnViewAt(t, 1799)).toMatchObject({ phase: 'queued', outcome: null, strike: null });
    expect(turnViewAt(t, 1800)).toMatchObject({ phase: 'ended', active: null, outcome: t.outcome, strike: null });
  });

  it('replays a stretch strike and a miss', () => {
    expectReplayMatches(rallyReturn(), [...keys('ball', 100), ...at(2000), ...keys('drop', 2900), ...at(3300)]);
    const miss = expectReplayMatches(rallyReturn({ isServeReturn: true }), [...keys('ba', 100), ...at(3399, 3400, 4000)]);
    expect(miss.outcome).toEqual({ kind: 'miss', endτ: 3400, ace: true });
  });

  it('replays a return turn frozen on its first chase and choice prompts', () => {
    const t = expectReplayMatches(rallyReturn({ freezeFirst: true }), [
      ...at(500),
      ...keys('ball', 1000),
      ...at(2000),
      ...keys('drop', 2300),
      ...at(3799, 3800, 5000),
    ]);
    expect(t.frozenMs).toBe(2000);
    expect(turnViewAt(t, 500).simτ).toBe(0);
    expect(turnViewAt(t, 2000).simτ).toBe(300);
  });

  it('shows nothing of an unstarted turn', () => {
    const t = createTurn(rallyReturn());
    expect(turnViewAt(t, 0)).toEqual({
      phase: 'chase',
      τ: 0,
      simτ: 0,
      prompts: [],
      active: null,
      tossAt: null,
      catchAt: null,
      chaseProgress: 0,
      strike: null,
      outcome: null,
    });
    expect(turnViewAt(createTurn(secondServe()), 5000).phase).toBe('leadIn');
  });

  it('builds fresh prompt views that do not alias the turn prompts', () => {
    const { t } = run(rallyReturn(), keys('ball', 100));
    const view = turnViewAt(t, 1000);
    view.prompts[0]!.options[0]!.word = 'zzz';
    expect(t.prompts[0]!.options[0]!.word).toBe('ball');
  });
});
