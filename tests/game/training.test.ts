import { describe, expect, it } from 'vitest';
import { CpuBrain, cpuProfile } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import { TIERS, type GameEvent, type PlayerInfo, type ReturnTurnData, type ViewModel } from '../../src/core/types';
import { initialsOk } from '../../src/core/words/picker';
import { MISLEADING_WORDS, packWords, tierOfLength } from '../../src/core/words/lists';
import { GLYPHS, textWidth } from '../../src/render/font';
import { VirtualScheduler } from '../../src/game/clock';
import { LocalSession } from '../../src/game/localSession';
import { COACH, TRAINING, TRAINING_WORDS, trainingConfig, trainingOptions } from '../../src/game/training';
import { activePrompt, drive, PLAYERS } from './sessionHelpers';

/** Width the HUD gives coach text per line (render/hud.ts), and its two-line limit. */
const COACH_TEXT_W = 214;

/** Greedy word wrap as the HUD's coach panel does it. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (textWidth(next) <= COACH_TEXT_W || line === '') line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

const TRAINEE: PlayerInfo = { ...PLAYERS[0], name: 'Kim' };
const SENSEI: PlayerInfo = { ...PLAYERS[1], name: 'Sensei', cpuLevel: 7 };

function trainingSession(seed = 1): { s: VirtualScheduler; session: LocalSession } {
  const s = new VirtualScheduler(1000);
  return { s, session: new LocalSession(trainingOptions({ players: [TRAINEE, SENSEI], seed, scheduler: s })) };
}

/** A copy of `vm` with `patch` applied to the copy. */
function variant(vm: ViewModel, patch: (v: ViewModel) => void): ViewModel {
  const v = structuredClone(vm);
  patch(v);
  return v;
}

const POINT: GameEvent = { turn: 1, τ: 0, type: 'point', winner: 0, reason: 'winner' };

describe('Training words and config (spec §3.12)', () => {
  it('fixed words are [easy, medium, hard] triples with valid initials, all distinct, from the Everyday pack', () => {
    const all = [...TRAINING_WORDS.serve, ...TRAINING_WORDS.choice];
    expect(TRAINING_WORDS.serve.length).toBeGreaterThanOrEqual(2);
    expect(TRAINING_WORDS.choice.length).toBeGreaterThanOrEqual(2);
    for (const triple of all) {
      expect(triple.map((w) => tierOfLength(w.length)), triple.join()).toEqual(TIERS);
      expect(initialsOk(triple), triple.join()).toBe(true);
      triple.forEach((w, i) => {
        expect(packWords('everyday', TIERS[i]!)).toContain(w);
        expect(MISLEADING_WORDS.has(w)).toBe(false);
      });
    }
    // No re-toss or choice ever offers a word from the previous set, nor the chase word.
    const words = all.flat();
    expect(new Set(words).size).toBe(words.length);
  });

  it('plays a Relaxed Tiebreak with no serve clock, first-prompt freezes and the fixed words, which the engine accepts', () => {
    const config = trainingConfig();
    expect(config).toMatchObject({ format: 'tiebreak', pace: 'relaxed', wordPack: 'everyday' });
    expect(config.training).toEqual({ serveClock: false, freezeUntilFirstKey: true, fixedWords: TRAINING_WORDS });
    expect(trainingConfig('clay').surface).toBe('clay');
    expect(() => new Engine({ config, players: [TRAINEE, SENSEI], seed: 1 })).not.toThrow();
  });

  it('trainingOptions: the trainee is player 0 and serves first against a White-belt CPU, with hints', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = new VirtualScheduler();
      const opts = trainingOptions({ players: [TRAINEE, SENSEI], seed, scheduler: s });
      expect(opts.human).toBe(0);
      expect(opts.players[0]).toEqual(TRAINEE);
      expect(opts.players[1]).toEqual({ ...SENSEI, kind: 'cpu', cpuLevel: 0 });
      expect(opts.training).toBe(TRAINING);
      expect(opts.hints).toBe(true);
      expect(opts.scheduler).toBe(s);
      expect(opts.config).toEqual(trainingConfig());
      expect(new Engine(opts).state.score.firstServerOfMatch).toBe(0);
      expect(trainingOptions({ players: [TRAINEE, SENSEI], seed, scheduler: s }).seed).toBe(opts.seed);
    }
  });

  it('every coach text uses only font glyphs and fits the HUD band in two lines', () => {
    for (const [name, text] of Object.entries(COACH)) {
      for (const ch of text) expect(GLYPHS[ch], `${name}: ${JSON.stringify(ch)}`).toBeDefined();
      expect(wrap(text).length, `${name}: ${wrap(text).join(' / ')}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('Training session', () => {
  it('coaches a scripted trainee through serve, return, rally and one real point', () => {
    const { s, session } = trainingSession(3);
    const trainee = new CpuBrain(0, cpuProfile(1), 8, { policy: 'alwaysEasy' });
    expect(session.lesson).toBe(0);
    expect(session.trainingDone).toBe(false);

    const coached = new Set<string>();
    const changes: { from: number; to: number; rally: number }[] = [];
    let lesson = 0;
    let rally = 0;
    let sawFrozenServe = false;
    drive(s, session, {
      me: 0,
      typist: trainee,
      limitMs: 30 * 60 * 1000,
      frameMs: 50,
      stop: () => session.trainingDone,
      onFrame: (vm) => {
        const t = vm.pub.turn;
        const p = activePrompt(t);
        if (vm.overlay.coach !== null) coached.add(vm.overlay.coach);
        // Lesson 1's first serve: SPACE, then type any word while the prompt is frozen.
        if (session.lesson === 0 && t?.data.owner === 0 && t.data.kind === 'serve') {
          if (t.phase === 'preServe' && t.setIndex === 0) expect(vm.overlay.coach).toBe(COACH.toss);
          if (t.phase === 'toss' && p?.locked === null) expect(vm.overlay.coach).toBe(COACH.serveWord);
          if (t.phase === 'toss' && t.freezeSince !== null) sawFrozenServe = true;
        }
        if (session.lesson === 1 && t?.data.owner === 0 && t.phase === 'chase') expect(vm.overlay.coach).toBe(COACH.chase);
        if (session.lesson === 1 && t?.data.owner === 0 && t.phase === 'choice' && p?.locked === null) {
          expect(vm.overlay.coach).toBe(COACH.choice);
        }
        if (session.lesson === 2 && t?.data.owner === 0 && t.phase === 'chase') expect(vm.overlay.coach).toBe(COACH.rally);
        // In-play strikes of the current point: every strike, less serves called as faults.
        let ended = rally;
        for (const e of vm.events) {
          if (e.type === 'strike') rally++;
          if (e.type === 'call' && e.call === 'fault') rally--;
          if (e.type === 'point') {
            ended = rally;
            rally = 0;
          }
        }
        const now = session.lesson ?? -1;
        if (now !== lesson) {
          expect(vm.events.some((e) => e.type === 'point'), `lesson ${lesson} → ${now} without a point`).toBe(true);
          changes.push({ from: lesson, to: now, rally: ended });
          lesson = now;
        }
      },
    });
    expect(session.trainingDone).toBe(true);
    expect(session.lesson).toBe(TRAINING.lessons.length);
    expect(changes.map((c) => c.to)).toEqual([1, 2, 3, 4]);
    expect(changes[2]!.rally).toBeGreaterThanOrEqual(3);
    expect(sawFrozenServe).toBe(true);
    for (const text of [COACH.toss, COACH.serveWord, COACH.chase, COACH.choice, COACH.rally, COACH.point]) {
      expect(coached).toContain(text);
    }
    // Once every lesson is done the coach falls silent.
    s.advance(16);
    expect(session.frame(16).overlay.coach).toBeNull();
  }, 60000);

  it('lessons: coach tips by situation, and when each lesson is done', () => {
    const { s, session } = trainingSession(3);
    const trainee = new CpuBrain(0, cpuProfile(1), 8, { policy: 'alwaysEasy' });
    let preServe: ViewModel | null = null;
    let afterMyShot: ViewModel | null = null;
    drive(s, session, {
      me: 0,
      typist: trainee,
      limitMs: 30 * 60 * 1000,
      frameMs: 50,
      stop: () => preServe !== null && afterMyShot !== null,
      onFrame: (vm) => {
        const t = vm.pub.turn;
        const last = vm.pub.lastTurn;
        if (t?.data.owner === 0 && t.data.kind === 'serve' && t.phase === 'preServe') preServe ??= vm;
        if (
          t?.data.owner === 1 &&
          t.data.kind === 'return' &&
          !t.data.isServeReturn &&
          last?.data.owner === 0 &&
          last.outcome?.kind === 'strike' &&
          !last.outcome.strike.stretch
        ) {
          afterMyShot ??= vm;
        }
      },
    });
    if (preServe === null || afterMyShot === null) throw new Error('situations not reached');
    const myShot: ViewModel = afterMyShot;
    const [serve, ret, rally, point] = TRAINING.lessons;
    if (serve === undefined || ret === undefined || rally === undefined || point === undefined) throw new Error('4 lessons');
    expect(TRAINING.lessons.map((l) => l.id)).toEqual(['serve', 'return', 'rally', 'point']);

    // How-to tips in lessons 1–2 only; explanations in every lesson; else the lesson's headline.
    expect(serve.coach(preServe)).toBe(COACH.toss);
    expect(ret.coach(preServe)).toBe(COACH.toss);
    expect(rally.coach(preServe)).toBe(COACH.rally);
    expect(point.coach(preServe)).toBe(COACH.point);
    expect(serve.coach(afterMyShot)).toBe(COACH.watch);
    const retoss = variant(preServe, (v) => (v.pub.turn!.setIndex = 1));
    const caught = variant(preServe, (v) => (v.pub.turn!.phase = 'catch'));
    const fault = variant(preServe, (v) => {
      const d = v.pub.turn!.data;
      if (d.kind === 'serve') d.leadIn = { kind: 'fault', ms: 1500, text: ['FAULT', 'NET'] };
      v.pub.turn!.phase = 'leadIn';
    });
    const dropped = variant(fault, (v) => {
      const d = v.pub.turn!.data;
      if (d.kind === 'serve') d.leadIn.text = ['FAULT', 'BALL DROPPED'];
    });
    const doubleFault = variant(fault, (v) => {
      const d = v.pub.turn!.data;
      if (d.kind === 'serve') d.leadIn = { kind: 'point', ms: 3500, text: ['FAULT', 'OUT', 'DOUBLE FAULT'] };
      d.owner = 1;
    });
    const stretch = variant(afterMyShot, (v) => {
      const o = v.pub.lastTurn!.outcome;
      if (o?.kind === 'strike') o.strike.stretch = true;
    });
    for (const lesson of [serve, ret, rally, point]) {
      expect(lesson.coach(retoss)).toBe(COACH.retoss);
      expect(lesson.coach(caught)).toBe(COACH.retoss);
      expect(lesson.coach(fault)).toBe(COACH.fault);
      expect(lesson.coach(dropped)).toBe(COACH.faultDropped);
      expect(lesson.coach(doubleFault)).toBe(COACH.doubleFault);
      expect(lesson.coach(stretch)).toBe(COACH.stretch);
    }
    const oppFault = variant(fault, (v) => (v.pub.turn!.data.owner = 1));
    expect(serve.coach(oppFault)).toBe(COACH.oppServe);
    expect(rally.coach(oppFault)).toBe(COACH.rally);

    // Lessons end only at the end of a point.
    const ended = (vm: ViewModel): ViewModel => variant(vm, (v) => (v.events = [POINT]));
    const seen = (vm: ViewModel, kinds: ('serve' | 'chase' | 'choice')[]): ViewModel =>
      variant(vm, (v) => (v.pub.seenKinds = [kinds, []]));
    expect(serve.done(seen(preServe, ['serve']))).toBe(false);
    expect(serve.done(ended(seen(preServe, ['serve'])))).toBe(true);
    expect(serve.done(ended(seen(preServe, ['chase', 'choice'])))).toBe(false);
    expect(ret.done(ended(seen(preServe, ['serve', 'chase'])))).toBe(false);
    expect(ret.done(ended(seen(preServe, ['serve', 'chase', 'choice'])))).toBe(true);
    const rallyOf = (n: number, incomingServe = false, outcome: 'in' | 'out' = 'in'): ViewModel =>
      ended(
        variant(myShot, (v) => {
          v.pub.lastTurn = v.pub.turn;
          const d = v.pub.lastTurn!.data as ReturnTurnData;
          d.n = n;
          d.incoming.isServe = incomingServe;
          d.incoming.outcome = outcome;
        }),
      );
    expect(rally.done(rallyOf(1))).toBe(false);
    expect(rally.done(rallyOf(2))).toBe(true);
    expect(rally.done(rallyOf(2, false, 'out'))).toBe(true);
    expect(rally.done(rallyOf(0, true, 'out'))).toBe(false);
    expect(rally.done(variant(rallyOf(5), (v) => (v.events = [])))).toBe(false);
    expect(point.done(preServe)).toBe(false);
    expect(point.done(ended(preServe))).toBe(true);
  }, 60000);

  it('a session without a script has no lesson and no coach', () => {
    const s = new VirtualScheduler();
    const opts = { ...trainingOptions({ players: [TRAINEE, SENSEI], seed: 1, scheduler: s }), training: null };
    const session = new LocalSession(opts);
    expect(session.lesson).toBeNull();
    expect(session.trainingDone).toBe(false);
    expect(session.frame(16).overlay.coach).toBeNull();
  });
});
