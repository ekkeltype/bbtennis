import { describe, expect, it } from 'vitest';
import { CpuBrain, cpuProfile } from '../../src/core/cpu';
import { TUNING } from '../../src/core/tuning';
import type { GameEvent, ViewModel } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { LocalSession, type LocalSessionOptions } from '../../src/game/localSession';
import { activePrompt, CPUS, drive, FRAME, keyOf, PLAYERS, seedWhere, TIEBREAK, turnStart } from './sessionHelpers';

function session(over: Partial<LocalSessionOptions> = {}): { s: VirtualScheduler; session: LocalSession } {
  const s = new VirtualScheduler(1000);
  const opts: LocalSessionOptions = { config: TIEBREAK, players: PLAYERS, seed: 1, human: 0, scheduler: s, ...over };
  return { s, session: new LocalSession(opts) };
}

/** Frames every FRAME ms until `until` holds (or fails the test after `limitMs`). */
function frameUntil(s: VirtualScheduler, x: LocalSession, until: (vm: ViewModel) => boolean, limitMs = 60000): ViewModel {
  const end = s.now() + limitMs;
  let vm = x.frame(FRAME);
  while (!until(vm)) {
    if (s.now() >= end) throw new Error('frameUntil: condition never held');
    s.advance(FRAME);
    vm = x.frame(FRAME);
  }
  return vm;
}

const types = (events: GameEvent[]): string[] => events.map((e) => e.type);

describe('LocalSession: a human-vs-CPU match', () => {
  it('a scripted human typing through session.key plays a Tiebreak to the end', () => {
    const { s, session: x } = session({ seed: 7 });
    const human = new CpuBrain(0, cpuProfile(6), 99);
    const seen: GameEvent[] = [];
    let matchAt: number | null = null;
    let overAt: number | null = null;
    let prev: { now: number; vm: ViewModel } | null = null;
    let transitions = 0;
    drive(s, x, {
      me: 0,
      typist: human,
      limitMs: 30 * 60 * 1000,
      onFrame: (vm) => {
        expect(Number.isFinite(vm.turnτ) && vm.turnτ >= 0, `turnτ ${vm.turnτ}`).toBe(true);
        expect(vm.viewer).toBe(0);
        expect(vm.liveTurn).toBeNull();
        seen.push(...vm.events);
        if (vm.events.some((e) => e.type === 'match')) matchAt = s.now();
        if (x.over && overAt === null) overAt = s.now();
        // The next turn starts exactly at the previous turn's start + its endτ (no drift).
        const end = vm.events.find((e) => e.type === 'turnEnd');
        if (prev !== null && end?.type === 'turnEnd' && vm.pub.turn !== null) {
          const prevStart = prev.now - prev.vm.turnτ;
          expect(turnStart(s, vm)).toBeCloseTo(prevStart + end.endτ, 6);
          transitions++;
        }
        prev = { now: s.now(), vm };
      },
    });
    expect(x.over).toBe(true);
    const result = x.result;
    expect(result).not.toBeNull();
    expect(result?.status).toBe('over');
    expect(result?.winner === 0 || result?.winner === 1).toBe(true);
    expect(result?.stats[0].wordsCompleted).toBeGreaterThan(0);
    expect(result?.stats[0].correctKeys).toBeGreaterThan(0);
    expect(transitions).toBeGreaterThan(10);
    // Every event reaches the view exactly once.
    const points = seen.filter((e) => e.type === 'point').length;
    expect(points).toBe((result?.stats[0].pointsWon ?? 0) + (result?.stats[1].pointsWon ?? 0));
    expect(seen.filter((e) => e.type === 'match')).toHaveLength(1);
    expect(seen.filter((e) => e.type === 'coinToss')).toHaveLength(1);
    // MATCH_OVER: `over` turns true after the 3 s celebration.
    expect(matchAt).not.toBeNull();
    expect(overAt! - matchAt!).toBeGreaterThanOrEqual(TUNING.leadIn.matchOverMs - FRAME);
    expect(overAt! - matchAt!).toBeLessThanOrEqual(TUNING.leadIn.matchOverMs + FRAME);
  }, 60000);

  it('shows the first turn from creation: the coin toss and the INTRO lead-in of the first server', () => {
    const { session: x } = session({ seed: seedWhere(1) });
    const vm = x.frame(FRAME);
    expect(types(vm.events)).toEqual(['coinToss', 'turnStart']);
    expect(vm.pub.turn?.data.owner).toBe(1);
    expect(vm.pub.turn?.phase).toBe('leadIn');
    expect(vm.turnτ).toBe(0);
    expect(x.frame(FRAME).events).toEqual([]);
  });

  it('turns a key\'s timeStamp into the owner\'s τ (timeStamp − turn start) and applies it at once', () => {
    const { s, session: x } = session({ seed: seedWhere(0) });
    const vm = frameUntil(s, x, (v) => v.pub.turn?.phase === 'preServe');
    const start = turnStart(s, vm);
    s.advance(10);
    x.key({ kind: 'toss' }, s.now() - 4);
    expect(x.view?.pub.turn?.phase).toBe('preServe');
    const after = x.frame(FRAME);
    const toss = after.events.find((e) => e.type === 'toss');
    expect(toss?.τ).toBeCloseTo(s.now() - 4 - start, 9);
    expect(after.pub.turn?.phase).toBe('toss');
    expect(after.pub.turn?.tossAt).toBeCloseTo(s.now() - 4 - start, 9);
  });

  it('feeds the CPU\'s planned keys at their planned τ and confirms the clock every frame', () => {
    const { s, session: x } = session({ seed: seedWhere(1) });
    const vm = frameUntil(s, x, (v) => v.pub.turn?.phase === 'toss');
    const t = vm.pub.turn!;
    expect(t.data.owner).toBe(1);
    // The CPU's toss is at its planned τ (lead-in end + 600..1200 ms), not at a frame boundary.
    const tossAt = t.tossAt!;
    expect(tossAt).toBeGreaterThanOrEqual(TUNING.leadIn.introMs + 600);
    expect(tossAt).toBeLessThanOrEqual(TUNING.leadIn.introMs + 1200);
    expect(tossAt % FRAME).not.toBe(0);
    expect(t.τ).toBeCloseTo(vm.turnτ, 9);
  });

  it('caps catch-up at 250 ms per frame: a late frame shifts the turn start instead of jumping', () => {
    const { s, session: x } = session({ seed: seedWhere(1) });
    s.advance(100);
    const a = x.frame(FRAME);
    expect(a.turnτ).toBe(100);
    s.advance(1000);
    const b = x.frame(1000);
    expect(b.turnτ).toBe(350);
    expect(b.pub.turn?.τ).toBe(350);
    s.advance(FRAME);
    expect(x.frame(FRAME).turnτ).toBe(350 + FRAME);
  });

  it('plays CPU turns the same at any frame rate: planned keys at their own τ, each turn from the last one\'s end', () => {
    const play = (frameMs: number): GameEvent[] => {
      const { s, session: x } = session({ players: CPUS, human: null, seed: 4 });
      const events: GameEvent[] = [];
      drive(s, x, { me: 0, typist: null, limitMs: 30 * 60 * 1000, frameMs, onFrame: (vm) => events.push(...vm.events) });
      expect(x.over).toBe(true);
      return events;
    };
    const at60Hz = play(FRAME);
    expect(at60Hz.filter((e) => e.type === 'point').length).toBeGreaterThan(6);
    expect(play(97)).toEqual(at60Hz);
  }, 60000);

  it('attract mode (human null) shows everything to a spectator and never reads keys', () => {
    const { s, session: x } = session({ players: CPUS, human: null, seed: 3 });
    const vm = frameUntil(s, x, (v) => v.pub.turn?.phase === 'toss');
    expect(vm.viewer).toBe('spectator');
    expect(activePrompt(vm.pub.turn)?.options.every((o) => o.word !== '')).toBe(true);
    const before = x.frame(FRAME);
    x.key(keyOf('a'), s.now());
    x.key({ kind: 'toss' }, s.now());
    const after = x.frame(FRAME);
    expect(after.pub).toEqual(before.pub);
    expect(after.overlay.wait).toBe(false);
    const end = drive(s, x, { me: 0, typist: null, limitMs: 30 * 60 * 1000, frameMs: 100 });
    expect(x.over).toBe(true);
    expect(end.pub.status).toBe('over');
  }, 60000);
});

describe('LocalSession: off-turn keys', () => {
  it('drops letters from the human while the CPU owns the turn, shows WAIT for 300 ms at most once per second', () => {
    const { s, session: x } = session({ seed: seedWhere(1) });
    s.advance(200);
    const before = x.frame(FRAME);
    expect(before.pub.turn?.data.owner).toBe(1);
    const t0 = s.now();
    x.key(keyOf('a'), t0);
    const at0 = x.frame(FRAME);
    expect(at0.overlay.wait).toBe(true);
    expect(at0.pub).toEqual(before.pub);
    expect(at0.events).toEqual([]);

    s.advance(299);
    expect(x.frame(FRAME).overlay.wait).toBe(true);
    s.advance(1);
    expect(x.frame(FRAME).overlay.wait).toBe(false);
    s.advance(200);
    x.key(keyOf('s'), s.now());
    expect(x.frame(FRAME).overlay.wait).toBe(false);
    s.advance(500);
    x.key(keyOf('d'), s.now());
    expect(x.frame(FRAME).overlay.wait).toBe(true);
  });

  it('ignores Space off-turn without WAIT, and letters in the human\'s own lead-in without WAIT', () => {
    const cpuServes = session({ seed: seedWhere(1) });
    frameUntil(cpuServes.s, cpuServes.session, (v) => v.pub.turn?.phase === 'preServe');
    const before = cpuServes.session.frame(FRAME);
    cpuServes.session.key({ kind: 'toss' }, cpuServes.s.now());
    const after = cpuServes.session.frame(FRAME);
    expect(after.overlay.wait).toBe(false);
    expect(after.pub).toEqual(before.pub);

    const humanServes = session({ seed: seedWhere(0) });
    const intro = humanServes.session.frame(FRAME);
    expect(intro.pub.turn?.phase).toBe('leadIn');
    humanServes.session.key(keyOf('a'), humanServes.s.now());
    const later = humanServes.session.frame(FRAME);
    expect(later.overlay.wait).toBe(false);
    expect(later.events).toEqual([]);
  });

  it('applies a key that arrives after the CPU\'s turn ended but before the next frame to the human\'s new turn', () => {
    // A first run finds when the CPU's serve is struck: the human's return turn starts at that moment.
    const probe = session({ seed: seedWhere(1) });
    const returnTurn = frameUntil(probe.s, probe.session, (v) => v.pub.turn?.data.kind === 'return');
    expect(returnTurn.pub.turn?.data.owner).toBe(0);
    const strike = returnTurn.events.find((e) => e.type === 'strike');
    if (strike?.type !== 'strike') throw new Error('no strike event');
    const strikeAt = turnStart(probe.s, returnTurn);

    // A replay frames up to just before the strike, then presses the chase word's first letter just after it.
    const { s, session: x } = session({ seed: seedWhere(1) });
    const vm = frameUntil(s, x, () => s.now() + FRAME >= strikeAt);
    expect(vm.pub.turn?.data.owner).toBe(1);
    s.advance(strikeAt + 5 - s.now());
    x.key(keyOf(strike.word.charAt(0)), s.now());
    const after = x.frame(FRAME);
    expect(after.overlay.wait).toBe(false);
    expect(after.pub.turn?.data.owner).toBe(0);
    expect(after.pub.turn?.data.kind).toBe('return');
    const chase = after.pub.turn!.prompts[0]!;
    expect(chase.kind).toBe('chase');
    expect(chase.correctKeys).toBe(1);
    expect(chase.tFirst).toBeCloseTo(5, 9);
  });
});

describe('LocalSession: pause and resume', () => {
  it.each([
    { name: 'the human\'s return turn', owner: 0, phase: 'chase' },
    { name: 'the CPU\'s serve turn', owner: 1, phase: 'toss' },
  ])('pausing 10 s mid-turn ($name) fires no deadline; resume counts 3-2-1 over 1.5 s, then the clock restarts', ({ owner, phase }) => {
    const { s, session: x } = session({ seed: seedWhere(1) });
    const at = frameUntil(s, x, (v) => v.pub.turn?.data.owner === owner && v.pub.turn.phase === phase && v.turnτ >= 300);
    const start = turnStart(s, at);
    x.pause();
    const paused = x.frame(FRAME);
    expect(paused.overlay.paused).toBe(true);
    expect(paused.overlay.countdown).toBeNull();
    const frozen = paused.turnτ;
    const frozenPub = JSON.stringify(paused.pub);
    const pausedAt = s.now();
    for (let t = 0; t < 10000; t += FRAME) {
      s.advance(FRAME);
      if (t === 4000) x.key(keyOf('a'), s.now());
      const vm = x.frame(FRAME);
      expect(vm.events).toEqual([]);
      expect(vm.turnτ).toBe(frozen);
      expect(JSON.stringify(vm.pub)).toBe(frozenPub);
      expect(vm.overlay.paused).toBe(true);
      expect(vm.overlay.wait).toBe(false);
    }
    s.advance(pausedAt + 10000 - s.now());
    x.resume();
    const resumedAt = s.now();
    const counts: number[] = [];
    for (let t = 0; t < 1500; t += 10) {
      const vm = x.frame(FRAME);
      expect(vm.overlay.paused).toBe(false);
      expect(vm.turnτ).toBe(frozen);
      expect(vm.events).toEqual([]);
      expect(JSON.stringify(vm.pub)).toBe(frozenPub);
      if (counts[counts.length - 1] !== vm.overlay.countdown) counts.push(vm.overlay.countdown!);
      if (t === 700) x.key(keyOf('a'), s.now());
      s.advance(10);
    }
    expect(counts).toEqual([3, 2, 1]);
    expect(s.now()).toBe(resumedAt + 1500);
    const go = x.frame(FRAME);
    expect(go.overlay.countdown).toBeNull();
    expect(go.turnτ).toBeCloseTo(frozen, 9);
    s.advance(40);
    expect(x.frame(FRAME).turnτ).toBeCloseTo(frozen + 40, 9);
    // The turn plays on to its end, 11.5 s later than it would have without the pause.
    let end: GameEvent | undefined;
    const last = frameUntil(s, x, (v) => (end = v.events.find((e) => e.type === 'turnEnd')) !== undefined);
    expect(last.events.length).toBeGreaterThan(0);
    if (end?.type !== 'turnEnd') throw new Error('no turnEnd');
    const shifted = start + 11500;
    expect(s.now() - shifted).toBeGreaterThanOrEqual(end.endτ);
    expect(s.now() - shifted).toBeLessThan(end.endτ + FRAME);
  });

  it('pause and resume are idempotent, and pausing during the countdown stays paused', () => {
    const { s, session: x } = session({ seed: seedWhere(1) });
    for (let t = 0; t < 500; t += 100) {
      s.advance(100);
      x.frame(FRAME);
    }
    x.resume();
    expect(x.frame(FRAME).overlay).toMatchObject({ paused: false, countdown: null });
    x.pause();
    s.advance(100);
    x.pause();
    s.advance(100);
    const vm = x.frame(FRAME);
    expect(vm.turnτ).toBe(500);
    x.resume();
    s.advance(600);
    x.resume();
    expect(x.frame(FRAME).overlay.countdown).toBe(2);
    x.pause();
    const again = x.frame(FRAME);
    expect(again.overlay).toMatchObject({ paused: true, countdown: null });
    s.advance(5000);
    expect(x.frame(FRAME).turnτ).toBe(500);
    x.resume();
    s.advance(1500);
    s.advance(100);
    expect(x.frame(FRAME).turnτ).toBe(600);
  });
});

describe('LocalSession: hints', () => {
  it('shows SPACE in the human\'s PRE_SERVE and the first-letter hint on the first choice prompt of each point, until its lock', () => {
    const { s, session: x } = session({ seed: 11, hints: true, config: { ...TIEBREAK, pace: 'relaxed' } });
    const human = new CpuBrain(0, cpuProfile(3), 5, { policy: 'alwaysEasy' });
    const firstChoice = new Map<number, number>();
    let spaces = 0;
    let letters = 0;
    let laterChoices = 0;
    drive(s, x, {
      me: 0,
      typist: human,
      limitMs: 30 * 60 * 1000,
      frameMs: 50,
      onFrame: (vm) => {
        const t = vm.pub.turn;
        const mine = t !== null && t.data.owner === 0;
        expect(vm.overlay.hintSpace).toBe(mine && t.data.kind === 'serve' && t.phase === 'preServe');
        const p = activePrompt(t);
        let expected = false;
        if (mine && p !== null && p.kind === 'choice') {
          if (!firstChoice.has(vm.pub.pointNo)) firstChoice.set(vm.pub.pointNo, p.id);
          expected = firstChoice.get(vm.pub.pointNo) === p.id && p.locked === null;
          if (firstChoice.get(vm.pub.pointNo) !== p.id && p.locked === null) laterChoices++;
        }
        expect(vm.overlay.hintFirstLetter).toBe(expected);
        if (vm.overlay.hintSpace) spaces++;
        if (vm.overlay.hintFirstLetter) letters++;
      },
    });
    expect(x.over).toBe(true);
    expect(spaces).toBeGreaterThan(0);
    expect(letters).toBeGreaterThan(0);
    // Some point gave the human a second choice prompt, so "only the first of each point" was exercised.
    expect(laterChoices).toBeGreaterThan(0);
  }, 60000);

  it('shows no hints without the hints option, or while paused', () => {
    const plain = session({ seed: seedWhere(0) });
    const vm = frameUntil(plain.s, plain.session, (v) => v.pub.turn?.phase === 'preServe');
    expect(vm.overlay.hintSpace).toBe(false);

    const hinted = session({ seed: seedWhere(0), hints: true });
    expect(frameUntil(hinted.s, hinted.session, (v) => v.pub.turn?.phase === 'preServe').overlay.hintSpace).toBe(true);
    hinted.session.pause();
    expect(hinted.session.frame(FRAME).overlay.hintSpace).toBe(false);
  });
});

describe('LocalSession: lifecycle', () => {
  it('exposes the latest view, and ignores keys, pause and resume after dispose', () => {
    const { s, session: x } = session({ seed: seedWhere(0) });
    expect(x.view).toBeNull();
    const vm = frameUntil(s, x, (v) => v.pub.turn?.phase === 'preServe');
    expect(x.view).toBe(vm);
    expect(x.over).toBe(false);
    expect(x.result).toBeNull();
    x.dispose();
    x.key({ kind: 'toss' }, s.now());
    x.pause();
    s.advance(500);
    const after = x.frame(FRAME);
    expect(after.pub.turn?.phase).toBe('preServe');
    expect(after.overlay.paused).toBe(false);
    expect(after.turnτ).toBe(vm.turnτ);
  });

  it('keeps the engine processed up to the shown τ when a key it does not use is followed by a pause', () => {
    const { s, session: x } = session({ seed: seedWhere(1) });
    frameUntil(s, x, (v) => v.pub.turn?.data.owner === 0 && v.pub.turn.phase === 'chase' && v.turnτ >= 200);
    s.advance(10);
    x.key({ kind: 'toss' }, s.now());
    x.pause();
    const vm = x.frame(FRAME);
    expect(vm.pub.turn?.τ).toBe(vm.turnτ);
  });

  it('clamps a key stamped in the future to now, and drops a key stamped before the current turn began', () => {
    const { s, session: x } = session({ seed: seedWhere(0) });
    const vm = frameUntil(s, x, (v) => v.pub.turn?.phase === 'preServe');
    x.key({ kind: 'toss' }, s.now() + 1e12);
    const tossed = x.frame(FRAME);
    expect(tossed.events.find((e) => e.type === 'toss')?.τ).toBe(vm.turnτ);

    const other = session({ seed: seedWhere(0) });
    const pre = frameUntil(other.s, other.session, (v) => v.pub.turn?.phase === 'preServe');
    other.session.key({ kind: 'toss' }, turnStart(other.s, pre) - 1);
    expect(other.session.frame(FRAME).pub.turn?.phase).toBe('preServe');
    other.session.key({ kind: 'toss' }, Number.NaN);
    expect(other.session.frame(FRAME).pub.turn?.phase).toBe('toss');
  });
});

describe('LocalSession: early typing (early-typing spec §2, §6.2)', () => {
  /** Plays with a scripted human (player 0, level 6) until `stop`, returning the session and its view. */
  function until(seed: number, stop: (vm: ViewModel) => boolean, early = false) {
    const { s, session: x } = session({ seed });
    const human = new CpuBrain(0, cpuProfile(6), 99);
    const vm = drive(s, x, { me: 0, typist: human, limitMs: 20 * 60 * 1000, stop, early });
    return { s, x, human, vm };
  }

  it("shows WAIT for the human's letters in the CPU's turn before its lock, and none after it", () => {
    const { s, x } = until(7, (v) => v.pub.turn?.data.kind === 'return' && v.pub.turn.data.owner === 1 && v.early === null);
    x.key(keyOf('q'), s.now());
    expect(x.frame(FRAME).overlay.wait).toBe(true);
    s.advance(1100); // past the WAIT tag's once-per-second limit
    const open = frameUntil(s, x, (v) => v.early?.player === 0);
    x.key(keyOf(open.early!.prompt.options[0]!.word[0]!), s.now());
    const after = x.frame(FRAME);
    expect(after.overlay.wait).toBe(false);
    expect(after.early?.prompt.typed).toBe(1);
    expect(after.events.some((e) => e.type === 'keyOk' && e.player === 0)).toBe(true);
  });

  it('carries the early keys into the return turn when the CPU strikes, and drops them when it does not', () => {
    let carried = 0;
    for (let seed = 1; seed <= 12 && carried === 0; seed++) {
      const { s, x } = until(seed, (v) => v.early?.player === 0);
      const cpuTurn = x.view!.pub.turn!.data.turnId;
      const word = x.view!.early!.prompt.options[0]!.word;
      x.key(keyOf(word[0]!), s.now());
      const before = x.frame(FRAME).pub.stats[0].correctKeys;
      const next = frameUntil(s, x, (v) => v.pub.turn !== null && v.pub.turn.data.turnId !== cpuTurn);
      expect(next.early).toBeNull();
      expect(next.events.every((e) => e.τ >= 0)).toBe(true);
      const t = next.pub.turn!;
      if (t.data.kind === 'return' && t.data.owner === 0) {
        expect(t.prompts[0]).toMatchObject({ typed: 1 });
        expect(t.prompts[0]!.tFirst).toBeLessThan(0);
        carried++;
      } else {
        expect(next.pub.stats[0].correctKeys).toBe(before); // nothing counted
      }
    }
    expect(carried).toBeGreaterThan(0);
  });

  it("a CPU receiver's early chase fills live and reaches the engine at the strike", () => {
    const { s, x } = until(5, (v) => v.early?.player === 1 && v.early.prompt.typed > 0);
    const humanTurn = x.view!.pub.turn!.data.turnId;
    const next = frameUntil(s, x, (v) => v.pub.turn !== null && v.pub.turn.data.turnId !== humanTurn);
    const t = next.pub.turn!;
    if (t.data.kind === 'return') expect(t.prompts[0]!.tFirst).toBeLessThan(0);
  });

  it('a pause during the early window keeps the chase and stamps later keys on game time', () => {
    const { s, x } = until(7, (v) => v.early?.player === 0);
    const word = x.view!.early!.prompt.options[0]!.word;
    x.key(keyOf(word[0]!), s.now());
    const first = x.frame(FRAME).early!.prompt.tFirst!;
    x.pause();
    s.advance(5000);
    x.resume();
    s.advance(1600); // the 3-2-1 countdown
    x.frame(FRAME);
    x.key(keyOf(word[1]!), s.now());
    const vm = x.frame(FRAME);
    if (vm.early !== null) expect(vm.early.prompt.tLast! - first).toBeLessThan(2000);
  });

  it('a whole match with a human who types early plays to the end', () => {
    const { x } = until(3, () => false, true);
    expect(x.over).toBe(true);
  });
});
