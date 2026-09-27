import { describe, expect, it, vi } from 'vitest';
import type { GameEvent, PlayerId, ViewModel } from '../../src/core/types';
import { ONLINE_PLAYBACK } from '../../src/game/displayQueue';
import { TICK_MS } from '../../src/game/onlineLink';
import type { NetMsg } from '../../src/net/protocol';
import { seedWhere } from '../game/sessionHelpers';
import {
  config,
  diffPoints,
  diffTurn,
  FRAME_MS,
  JITTER_MS,
  maxOneWayMs,
  playMatch,
  redactionLeaks,
  Rig,
  settleReport,
  turnRecord,
  type MatchRun,
} from './sessionHarness';

const TIEBREAK = config('tiebreak');
const SHORT_SET = config('short');

/** Nominal one-way latencies of the invariance check; each run adds ±30 ms of seeded jitter. */
const LATENCIES = [0, 150, 400] as const;
/** The match every latency plays: same seed, same scripted typists (a 14-point tiebreak with re-tosses by both). */
const INVARIANCE_SEED = 2;
/** Three different short-set matches, one per latency (first servers: host, guest, guest). */
const SHORT_SETS = [
  { seed: 11, latencyMs: 150 },
  { seed: 12, latencyMs: 400 },
  { seed: 13, latencyMs: 0 },
] as const;

/** The short sets are long: they run at 30 fps (turn clocks never read the frame rate) to keep the suite short. */
const SHORT_SET_FRAME_MS = 32;
/** Generous: three full short-set matches take a while to simulate. */
const SHORT_SETS_TIMEOUT = 240_000;
const INVARIANCE_TIMEOUT = 120_000;

/** Spec §6: after a strike, the guest's playback of the host's return settles within 1.5 s. */
const SETTLE_AFTER_MS = 1500;
/**
 * Settled: a mean lag of margin ± this per 50 ms confirmation period. It is playback.test.ts's ±20 ms
 * (a fixed delay, no jitter), widened by the ±30 ms by which each confirmation's arrival may move.
 */
const SETTLE_TOLERANCE_MS = 20 + JITTER_MS;
/** One confirmation per 50 ms tick, each taking latency ± 30 ms: consecutive ones arrive at most this far apart. */
const MAX_CONFIRMATION_GAP_MS = TICK_MS + 2 * JITTER_MS;

/**
 * Runs `make` once, on first use, so each test can ask for the shared matches whatever runs first. A
 * failure is kept and rethrown to every later caller, so one broken match fails each test that needs it
 * at once instead of being replayed for each.
 */
function lazy<T>(make: () => T): () => T {
  let made: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  return () => {
    if (made === null) {
      try {
        made = { ok: true, value: make() };
      } catch (error) {
        made = { ok: false, error };
      }
    }
    if (!made.ok) throw made.error;
    return made.value;
  };
}

const invarianceRuns = lazy(() =>
  LATENCIES.map((latencyMs) => playMatch({ config: TIEBREAK, seed: INVARIANCE_SEED, latencyMs, jitterSeed: 100 + latencyMs })),
);
const shortSetRuns = lazy(() =>
  SHORT_SETS.map(({ seed, latencyMs }) => playMatch({ config: SHORT_SET, seed, latencyMs, jitterSeed: seed, frameMs: SHORT_SET_FRAME_MS })),
);
const allRuns = (): MatchRun[] => [...invarianceRuns(), ...shortSetRuns()];

/** A played-out match: both sides over as 'finished', no warning of any kind, every turn seen by both sides. */
function expectFinished(run: MatchRun): void {
  const where = `seed ${run.seed} at ${run.latencyMs} ms`;
  expect(run.rig.host.endReason, where).toBe('finished');
  expect(run.rig.guest.endReason, where).toBe('finished');
  expect(run.rig.host.over && run.rig.guest.over, where).toBe(true);
  expect(run.warnings, where).toEqual([]);
  for (const log of [run.hostLog, run.guestLog]) {
    const ids = [...log.turns.keys()].sort((a, b) => a - b);
    expect(ids.length, where).toBeGreaterThan(10);
    expect(ids, where).toEqual(ids.map((_, i) => i + 1));
  }
}

describe('the shared matches', () => {
  it('are built on first use only; a build that fails is kept and rethrown to every test that asks, never built again', () => {
    let builds = 0;
    const ok = lazy(() => ++builds);
    expect([ok(), ok()]).toEqual([1, 1]);
    const boom = new Error('a typist fell behind');
    let tries = 0;
    const bad = lazy((): number => {
      tries++;
      throw boom;
    });
    expect(bad).toThrow(boom);
    expect(bad).toThrow(boom);
    expect(tries).toBe(1);
  });
});

describe('online sessions run headless', () => {
  it('have no DOM to touch: a VirtualScheduler and a loopback transport are all they get', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof requestAnimationFrame).toBe('undefined');
    const rig = new Rig({ config: TIEBREAK, seed: 1, latencyMs: 150, jitterSeed: 1 });
    rig.play({ limitMs: 3000 });
    expect(rig.host.view?.pub.turn?.data.turnId).toBe(1);
    expect(rig.guest.view?.pub.turn?.data.turnId).toBe(1);
  });
});

describe('online sessions: latency invariance', () => {
  it('the same seed and scripted typists give an identical point-by-point outcome at 0, 150 and 400 ms one-way latency with ±30 ms jitter', () => {
    const runs = invarianceRuns();
    for (const run of runs) expectFinished(run);
    // The latency really differed: the measured round trip is two one-way delays of latency ± 30 ms.
    const rtts = runs.map((r) => r.rig.host.view?.overlay.rttMs ?? -1);
    for (const [i, ms] of LATENCIES.entries()) {
      expect(rtts[i]).toBeGreaterThanOrEqual(2 * Math.max(0, ms - 30));
      expect(rtts[i]).toBeLessThanOrEqual(2 * maxOneWayMs(ms));
    }

    const [base, ...others] = runs as [MatchRun, ...MatchRun[]];
    const points = base.hostLog.points();
    expect(points.length).toBeGreaterThanOrEqual(7);
    // The typists exercised strikes and re-tosses by both players, and turns that ended otherwise.
    const turns = points.flatMap((p) => p.turns);
    for (const who of [0, 1] as PlayerId[]) {
      expect(turns.some((t) => t.owner === who && t.strike !== null)).toBe(true);
      expect(base.rig.hostWire.sent.some(({ m }) => m.type === 'frame' && m.ev?.some((e) => e.type === 'catch' && e.player === who))).toBe(true);
    }
    expect(turns.some((t) => t.outcome !== 'strike')).toBe(true);

    for (const run of others) {
      const where = `${run.latencyMs} ms vs ${base.latencyMs} ms`;
      expect(diffPoints(base.hostLog.points(), run.hostLog.points()), `host, ${where}`).toEqual([]);
      expect(diffPoints(base.guestLog.points(), run.guestLog.points()), `guest, ${where}`).toEqual([]);
      const [a, b] = [base.rig.host.result!, run.rig.host.result!];
      expect(b.winner, where).toBe(a.winner);
      expect(b.score, where).toEqual(a.score);
    }
  }, INVARIANCE_TIMEOUT);
});

describe('online sessions: three full short-set matches', () => {
  it('no desync warnings: the guest\'s local outcome of every turn it owns equals the host\'s', () => {
    const runs = shortSetRuns();
    const firstServers = new Set<PlayerId>();
    for (const run of runs) {
      expectFinished(run);
      expect(run.rig.host.result!.score.setsWon.some((n) => n === 1)).toBe(true);
      firstServers.add(run.rig.host.result!.score.firstServerOfMatch);
      const guestOwned = [...run.guestLog.turns.values()].filter((t) => t.owner === 1);
      expect(guestOwned.length).toBeGreaterThan(20);
      expect(run.guestLog.turns.size).toBe(run.hostLog.turns.size);
      for (const [id, mine] of run.guestLog.turns) {
        expect(diffTurn(run.hostLog.turns.get(id)!, mine), `seed ${run.seed}, turn ${id}`).toEqual([]);
      }
    }
    expect(firstServers.size).toBe(2);
    // The meter reaches 4 and the scripted typists hit insane words, so the 4-option path runs online.
    const insaneStrikes = runs.flatMap((run) => [...run.hostLog.turns.values()].filter((t) => t.strike?.option === 3));
    expect(insaneStrikes.length).toBeGreaterThan(0);
  }, SHORT_SETS_TIMEOUT);
});

describe('online sessions: the guest\'s playback of host-owned turns', () => {
  it('never runs ahead of the τ the host has confirmed and never goes back within a turn', () => {
    for (const run of allRuns()) {
      const where = `seed ${run.seed} at ${run.latencyMs} ms`;
      expect(run.playback.violations, where).toEqual([]);
      // Host-owned turns were really played back, and playback often caught up and waited at the confirmed τ.
      expect(run.playback.checked, where).toBeGreaterThan(1000);
      expect(run.playback.atCap, where).toBeGreaterThan(10);
    }
  }, SHORT_SETS_TIMEOUT + INVARIANCE_TIMEOUT);

  it('settles within 1.5 s of each guest strike in every match: from then until the host\'s return ends, 60 ± 50 ms behind the confirmed τ per 50 ms period', () => {
    const unsettled: string[] = [];
    const starved: string[] = [];
    const details: string[] = [];
    for (const run of allRuns()) {
      const where = `seed ${run.seed} at ${run.latencyMs} ms`;
      const report = settleReport(run.playback, SETTLE_AFTER_MS, TICK_MS);
      // Enough of the host's returns lasted past the deadline to judge.
      expect(report.turns, where).toBeGreaterThan(20);
      expect(report.periods.length, where).toBeGreaterThan(500);
      const outside = report.periods.filter((p) => !(Math.abs(p.lag - ONLINE_PLAYBACK.margin) <= SETTLE_TOLERANCE_MS));
      if (outside.length > 0) {
        unsettled.push(where);
        const some = outside.slice(0, 3).map((p) => `turn ${p.turn} at strike + ${p.afterStrikeMs.toFixed(0)} ms: ${p.lag.toFixed(1)} ms`);
        details.push(`${where}: ${outside.length} of ${report.periods.length} periods outside, e.g. ${some.join('; ')}`);
      }
      if (report.maxGapMs > MAX_CONFIRMATION_GAP_MS) starved.push(where);
    }
    expect(unsettled, details.join('\n')).toEqual([]);
    // Confirmations flowed (spec §5.3: they are never skipped): none waited longer than a tick plus the jitter window.
    expect(starved).toEqual([]);
  }, SHORT_SETS_TIMEOUT + INVARIANCE_TIMEOUT);
});

describe('online sessions: "Connection unstable…" (spec §5.3)', () => {
  it('no view of either side in any full match shows it: the hand-off freeze of up to 2 × (400 + 30) ms before a turn\'s first confirmation is no stall', () => {
    for (const run of allRuns()) {
      const where = `seed ${run.seed} at ${run.latencyMs} ms`;
      expect(run.rig.unstableViews('host'), where).toBe(0);
      expect(run.rig.unstableViews('guest'), where).toBe(0);
      expect(run.rig.frameCount('host'), where).toBeGreaterThan(1000);
    }
  }, SHORT_SETS_TIMEOUT + INVARIANCE_TIMEOUT);

  it('at 600 ms one-way, where a hand-off freezes the ball for over 1 s before the first confirmation, neither side shows it: the stall second starts a round trip after the turn began', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rig = new Rig({ config: TIEBREAK, seed: INVARIANCE_SEED, latencyMs: 600, jitterSeed: 9 });
      rig.play({ limitMs: 45_000 });
      expect(rig.host.view!.pub.turn!.data.turnId).toBeGreaterThanOrEqual(8);
      expect(rig.unstableViews('host')).toBe(0);
      expect(rig.unstableViews('guest')).toBe(0);
      expect(rig.host.endReason).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe('online sessions: redaction', () => {
  it('no frame sent to the guest, bare confirmations included, contains the host\'s serve words (unless struck or public), spare sets or randoms', () => {
    for (const run of allRuns()) {
      const where = `seed ${run.seed} at ${run.latencyMs} ms`;
      const scan = redactionLeaks(run.rig.hostWire.sent, run.secrets);
      expect(scan.leaks, where).toEqual([]);
      // Every frame was scanned; most are bare confirmations (spec §5.3).
      expect(scan.frames, where).toBe(run.rig.hostWire.sent.filter(({ m }) => m.type === 'frame').length);
      expect(scan.confirmations, where).toBeGreaterThan(scan.frames / 2);
      // The scan had something to find: frames carrying host turns, and every frame checked against each
      // host serve word still secret (spare and appended sets too) and each host random. The floors are
      // about half the smallest match's counts (the 0 ms tiebreak: ~97k word checks after gentler rally
      // pressure, randoms still ~1.9M).
      expect(scan.framesWithHostTurns, where).toBeGreaterThan(500);
      expect(scan.wordsChecked, where).toBeGreaterThan(50_000);
      expect(scan.randomsChecked, where).toBeGreaterThan(1_000_000);
      expect(run.secrets.maxSets, where).toBeGreaterThanOrEqual(3);
    }
  }, SHORT_SETS_TIMEOUT + INVARIANCE_TIMEOUT);

  it('the scan finds a leak: a frame carrying the host\'s own view of its serve turn is flagged', () => {
    const run = invarianceRuns()[0]!;
    const own = run.secrets.hostServeTurn;
    expect(own).not.toBeNull();
    const leaky = { type: 'frame' as const, turn: own!.data.turnId, τ: 0, s: { ...run.rig.host.result!, turn: own!, lastTurn: null } };
    const scan = redactionLeaks([{ at: 0, m: leaky, json: JSON.stringify(leaky) }], run.secrets);
    expect(scan.leaks.some((l) => l.includes('serve word'))).toBe(true);
    expect(scan.leaks.some((l) => l.includes('random'))).toBe(true);
  }, INVARIANCE_TIMEOUT);

  it('the scan checks every frame, in order, against every secret: a word in a frame with no host turn and a random in a bare confirmation are flagged, and a word only once struck is not', () => {
    const run = invarianceRuns()[0]!;
    const d = run.secrets.hostServeTurn!.data;
    const word = d.kind === 'serve' ? d.wordSets.at(-1)!.options[1]!.word : '';
    const final = run.rig.host.result!;
    const [p0, p1] = final.players;
    // The word slips out through a name; the random as a confirmation's τ.
    const named: NetMsg = { type: 'frame', turn: 999, τ: 0, s: { ...final, turn: null, lastTurn: null, players: [{ ...p0, name: word }, p1] } };
    const bare: NetMsg = { type: 'frame', turn: 999, τ: d.randoms[0] };
    const strike: GameEvent = { turn: 999, τ: 0, type: 'strike', player: 0, word, tier: 'medium', kmh: 120, isServe: true, stretch: false, forehand: true };
    const struck: NetMsg = { type: 'frame', turn: 999, τ: 0, ev: [strike] };
    const scan = redactionLeaks([named, bare, struck, named].map((m, i) => ({ at: i, m, json: JSON.stringify(m) })), run.secrets);
    expect(word).toMatch(/^[a-z]+$/);
    expect(scan.leaks.filter((l) => l.includes(`"${word}"`)).map((l) => l.split(':')[0])).toEqual(['at 0']);
    expect(scan.leaks.some((l) => l.startsWith('at 1:') && l.includes('random'))).toBe(true);
  }, INVARIANCE_TIMEOUT);
});

describe('online sessions: the host\'s rAF suspended for 5 s during a guest-owned turn', () => {
  const SUSPEND_MS = 5000;

  it.each(['serve', 'return'] as const)('a guest %s turn still resolves on the host at the guest\'s τ, through messages and the ticker alone', (kind) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The guest serves first; it never lets a toss be caught, so its serve ends within 5 s of the toss.
      const rig = new Rig({ config: TIEBREAK, seed: seedWhere(1), latencyMs: 150, jitterSeed: 3, guestTypist: { catchChance: 0 } });
      const guestTurn = (): { id: number; startAt: number } | null => {
        const vm = rig.guest.view;
        const t = vm?.liveTurn ?? null;
        if (vm === null || t === null || t.ended || t.data.kind !== kind) return null;
        if (kind === 'serve' ? t.phase !== 'toss' : t.τ > FRAME_MS) return null;
        return { id: t.data.turnId, startAt: rig.s.now() - vm.turnτ };
      };
      rig.play({ limitMs: 120_000, stop: () => guestTurn() !== null });
      const target = guestTurn();
      expect(target).not.toBeNull();
      const { id, startAt } = target!;

      const from = rig.s.now();
      const hostFrames = rig.frameCount('host');
      const heardBefore = rig.guestWire.received.length;
      rig.suspend('host');
      let unstable = false;
      rig.play({ limitMs: SUSPEND_MS, onFrame: (side, vm) => (unstable ||= side === 'guest' && vm.overlay.unstable) });
      expect(rig.s.now() - from).toBeGreaterThanOrEqual(SUSPEND_MS);
      expect(rig.frameCount('host')).toBe(hostFrames);
      // The host kept talking (frames, pings) from its ticker, so the guest never saw the link as unstable.
      expect(rig.guestWire.received.length - heardBefore).toBeGreaterThan(SUSPEND_MS / 250);
      expect(unstable).toBe(false);
      expect(rig.host.endReason).toBeNull();

      // The guest's own outcome of the turn, from its local runner.
      const mine = rig.guestLog.turns.get(id);
      expect(mine).toBeDefined();
      expect(mine!.owner).toBe(1);
      // The host resolved it while suspended, as soon as the guest's input or clock could reach it.
      const resolved = rig.hostWire.sent.find(({ m }) => m.type === 'frame' && [m.s?.turn, m.s?.lastTurn].some((t) => t?.data.turnId === id && t.ended));
      expect(resolved).toBeDefined();
      expect(resolved!.at).toBeGreaterThan(from);
      expect(resolved!.at).toBeLessThanOrEqual(startAt + mine!.endτ + TICK_MS + maxOneWayMs(150));
      const m = resolved!.m;
      const theirs = m.type === 'frame' ? [m.s?.turn, m.s?.lastTurn].find((t) => t?.data.turnId === id) : undefined;
      expect(diffTurn(turnRecord(theirs!), mine!)).toEqual([]);

      // The ticker alone moved the host's display on: the guest struck, and the host's return turn that
      // follows started while the host was hidden (its clock keeps running).
      expect(mine!.strike).not.toBeNull();
      const next = rig.hostWire.sent.find(({ at, m }) => at > resolved!.at && m.type === 'frame' && m.s?.turn?.data.turnId === id + 1 && m.s.turn.started);
      expect(next).toBeDefined();
      expect(next!.at).toBeLessThanOrEqual(from + SUSPEND_MS);
      expect(next!.m.type === 'frame' ? next!.m.s?.turn?.data.owner : null).toBe(0);

      rig.resume('host');
      rig.play({ limitMs: FRAME_MS, typists: false });
      expect(rig.host.view?.pub.turn?.data.turnId).toBeGreaterThan(id);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe('online sessions: a side hidden for 20 s (spec §5.2)', () => {
  const HIDDEN_MS = 20_000;
  /** Spec §5.2: back from hidden, one-shot events more than 300 ms old are dropped. */
  const STALE_MS = 300;

  /**
   * How far (ms of display time) a view's display had moved past each of its events: the displayed
   * turn's by its τ, the turn shown before it by its end plus the displayed τ, and any older turn's is
   * taken as Infinity (a whole turn lies between).
   */
  function ages(vm: ViewModel): { e: GameEvent; age: number }[] {
    const [f, p] = [vm.pub.turn, vm.pub.lastTurn];
    return vm.events.map((e) => {
      if (f !== null && e.turn === f.data.turnId) return { e, age: vm.turnτ - e.τ };
      if (f !== null && p !== null && e.turn === p.data.turnId && p.outcome !== null) return { e, age: p.outcome.endτ - e.τ + vm.turnτ };
      return { e, age: Number.POSITIVE_INFINITY };
    });
  }

  it.each([['host', 0], ['guest', 1]] as const)('the %s\'s first frame back shows only the events its display passed in the last 300 ms, though the match went on meanwhile', (name, me) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rig = new Rig({ config: TIEBREAK, seed: 5, latencyMs: 150, jitterSeed: 5 });
      const session = rig[name];
      // Hidden as the opponent is about to serve, so the match runs on without this side's keys.
      rig.play({ limitMs: 60_000, stop: () => {
        const t = session.view?.pub.turn;
        return t !== null && t !== undefined && t.data.kind === 'serve' && t.data.owner !== me && !t.ended && rig.s.now() > 5000;
      } });
      const before = session.view!.pub.turn!.data.turnId;
      rig.suspend(name);
      rig.play({ limitMs: HIDDEN_MS });
      rig.resume(name);
      const back: ViewModel[] = [];
      rig.play({ limitMs: 1000, typists: false, onFrame: (side, vm) => side === name && back.push(vm) });
      expect(back.length).toBeGreaterThan(30);
      // Confirmations flowed all along: coming back shows no "Connection unstable…".
      expect(back.filter((v) => v.overlay.unstable)).toHaveLength(0);
      const vm = back[0]!;
      // The display moved on through several turns (each with its strikes, bounces, keys and calls).
      expect(vm.pub.turn!.data.turnId).toBeGreaterThanOrEqual(before + 2);
      expect(ages(vm).filter(({ age }) => !(age <= STALE_MS))).toEqual([]);
      expect(session.endReason).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe('online sessions: disconnect', () => {
  /** A tiebreak 20 s in, both sides still playing. */
  function midMatch(): Rig {
    const rig = new Rig({ config: TIEBREAK, seed: 5, latencyMs: 150, jitterSeed: 5 });
    rig.play({ limitMs: 20_000 });
    expect(rig.host.endReason).toBeNull();
    return rig;
  }

  it('closing the guest\'s transport ends the host\'s match at once with the disconnect reason', () => {
    const rig = midMatch();
    const closedAt = rig.s.now();
    rig.guestWire.close();
    const ended: number[] = [];
    rig.play({ limitMs: 2000, onFrame: (side) => side === 'host' && rig.host.endReason !== null && ended.push(rig.s.now()) });
    expect(rig.host.endReason).toBe('disconnect');
    expect(rig.host.opponentGone).toBe('disconnect');
    expect(rig.host.over).toBe(true);
    // Not a played-out match: nothing is recorded as finished.
    expect(rig.host.result?.status).toBe('playing');
    expect(ended.length).toBeGreaterThan(0);
    expect(ended[0]! - closedAt).toBeLessThanOrEqual(maxOneWayMs(150) + FRAME_MS);
  });

  it('8 s without a message from the guest ends the host\'s match with the disconnect reason, and not a tick earlier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rig = midMatch();
      rig.guestWire.mute = true;
      const timeline: { at: number; ended: boolean }[] = [];
      rig.play({ limitMs: 10_000, onFrame: (side) => side === 'host' && timeline.push({ at: rig.s.now(), ended: rig.host.endReason !== null }) });
      // The last message the host heard (sent before the guest went silent).
      const lastHeard = rig.hostWire.received.at(-1)!.at;
      const before = timeline.filter((f) => f.at < lastHeard + 8000);
      const after = timeline.filter((f) => f.at >= lastHeard + 8000 + TICK_MS);
      expect(before.length).toBeGreaterThan(400);
      expect(after.length).toBeGreaterThan(50);
      expect(before.every((f) => !f.ended)).toBe(true);
      expect(after.every((f) => f.ended)).toBe(true);
      expect(rig.host.endReason).toBe('disconnect');
      expect(rig.host.opponentGone).toBe('disconnect');
      expect(rig.host.over).toBe(true);
      expect(rig.host.result?.status).toBe('playing');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
