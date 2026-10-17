import { describe, expect, it } from 'vitest';
import { ArcadeCpu } from '../../src/arcade/core/cpu';
import { DT } from '../../src/arcade/core/tuning';
import { NO_INPUT, type ArcadeConfig, type Controller, type PlayerInput } from '../../src/arcade/core/types';
import { ArcadeSession } from '../../src/arcade/game/session';
import type { PlayerInfo } from '../../src/core/types';

const config: ArcadeConfig = { format: 'tiebreak', deuceRule: 'golden', surface: 'hard', pace: 'normal' };
const look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const players: [PlayerInfo, PlayerInfo] = [
  { name: 'A', look, kind: 'cpu', cpuLevel: 5 },
  { name: 'B', look, kind: 'cpu', cpuLevel: 5 },
];
const idle: Controller = { input: () => NO_INPUT };
const FRAME = 1000 / 60;

function make(controllers: [Controller, Controller] = [idle, idle], seed = 7) {
  return new ArcadeSession({ config, players, seed, controllers, viewer: 0 });
}

describe('ArcadeSession frames', () => {
  it('runs at most 15 ticks per frame and drops the rest', () => {
    const s = make();
    const v = s.frame(1000);
    expect(v.state.tick).toBe(15);
    expect(v.t).toBeCloseTo(15 * DT, 9);
    expect(s.frame(0).state.tick).toBe(15);
  });

  it('runs 60 ticks for 60 frames of 16.667 ms', () => {
    const s = make();
    let v = s.frame(0);
    for (let i = 0; i < 60; i++) v = s.frame(16.667);
    expect(v.state.tick).toBe(60);
  });

  it('view.t is tick time plus the leftover toward the next tick', () => {
    const s = make();
    const v = s.frame(FRAME * 2.5);
    expect(v.state.tick).toBe(2);
    expect(v.t).toBeCloseTo(2.5 * DT, 6);
    const w = s.frame(FRAME * 0.25);
    expect(w.state.tick).toBe(2);
    expect(w.t).toBeCloseTo(2.75 * DT, 6);
  });

  it('calls the controllers once per tick, in player order', () => {
    const calls: number[] = [];
    const mk = (n: number): Controller => ({ input: (): PlayerInput => { calls.push(n); return NO_INPUT; } });
    const s = make([mk(0), mk(1)]);
    s.frame(FRAME * 3.1);
    expect(calls).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('delivers every event in exactly one frame', () => {
    const s = make([new ArcadeCpu(0, 5, 11), new ArcadeCpu(1, 5, 11)], 11);
    const seen: object[] = [];
    for (let i = 0; i < 1500; i++) seen.push(...s.frame(FRAME).events);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.map((e) => (e as { type: string }).type)).toContain('hit');
  });
});

describe('ArcadeSession pause and resume', () => {
  it('pause freezes the sim and yields no events', () => {
    const s = make();
    s.frame(FRAME * 5);
    s.pause();
    const v = s.frame(5000);
    expect(v.state.tick).toBe(5);
    expect(v.events).toEqual([]);
    expect(v.overlay).toEqual({ paused: true, countdown: null });
  });

  it('does not bank time while paused', () => {
    const s = make();
    s.pause();
    s.frame(5000);
    s.resume();
    s.frame(3000);
    const v = s.frame(FRAME * 2);
    expect(v.state.tick).toBeLessThanOrEqual(2);
  });

  it('resume counts 3, 2, 1 over 3 s with no ticks, then runs', () => {
    const s = make();
    s.pause();
    s.resume();
    expect(s.frame(0).overlay).toEqual({ paused: false, countdown: 3 });
    expect(s.frame(500).overlay.countdown).toBe(3);
    expect(s.frame(600).overlay.countdown).toBe(2);
    expect(s.frame(1000).overlay.countdown).toBe(1);
    const v = s.frame(800);
    expect(v.overlay.countdown).toBe(1);
    expect(v.state.tick).toBe(0);
    const w = s.frame(200);
    expect(w.overlay).toEqual({ paused: false, countdown: null });
    expect(w.state.tick).toBe(0);
    expect(s.frame(FRAME * 2).state.tick).toBe(2);
  });

  it('pause during a countdown pauses again', () => {
    const s = make();
    s.resume();
    s.frame(1000);
    s.pause();
    expect(s.frame(5000).overlay).toEqual({ paused: true, countdown: null });
  });
});

describe('ArcadeSession end', () => {
  it('reaches over in a CPU-vs-CPU tiebreak and sets result', () => {
    const seed = 3;
    const s = make([new ArcadeCpu(0, 7, seed), new ArcadeCpu(1, 7, seed)], seed);
    expect(s.over).toBe(false);
    expect(s.result).toBeNull();
    let n = 0;
    while (!s.over && n++ < 60 * 60 * 30) s.frame(FRAME);
    expect(s.over).toBe(true);
    expect(s.result?.status).toBe('over');
    const tick = s.result!.tick;
    const v = s.frame(1000);
    expect(v.events).toEqual([]);
    expect(v.state.tick).toBe(tick);
  });

  it('never throws after dispose', () => {
    const s = make();
    s.frame(FRAME * 3);
    s.dispose();
    const v = s.frame(1000);
    expect(v.events).toEqual([]);
    expect(v.state.tick).toBe(3);
  });

  it('view is null before the first frame', () => {
    expect(make().view).toBeNull();
  });
});

describe('ArcadeSession guards', () => {
  it('a stray resume() on a running session does not freeze it', () => {
    const s = make();
    s.frame(FRAME);
    s.resume();
    expect(s.frame(FRAME).state.tick).toBe(2);
  });

  it('a second resume() during the countdown does not restart it', () => {
    const s = make();
    s.pause();
    s.resume();
    expect(s.frame(1000).overlay.countdown).toBe(2);
    s.resume();
    expect(s.frame(1000).overlay.countdown).toBe(1);
    expect(s.frame(1000).overlay.countdown).toBeNull();
    expect(s.frame(FRAME).state.tick).toBe(1);
  });

  it('frame(NaN) runs no ticks and later frames run normally', () => {
    const s = make();
    expect(s.frame(NaN).state.tick).toBe(0);
    expect(s.frame(Infinity).state.tick).toBe(0);
    expect(s.frame(FRAME).state.tick).toBe(1);
    expect(s.frame(FRAME).state.tick).toBe(2);
  });
});
