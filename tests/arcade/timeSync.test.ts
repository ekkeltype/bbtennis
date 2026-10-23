import { describe, expect, it } from 'vitest';
import { NET } from '../../src/arcade/game/rollback';
import { TimeSync } from '../../src/arcade/game/timeSync';

/**
 * Two tick clocks started `offsetMs` apart, each running at its TimeSync rate, sending its latest
 * input tick and advantage every tick over a `latencyMs` link; a side waits once it is maxPredict ticks
 * past the other's last input, as the session does. Returns both clocks over time.
 */
function run(offsetMs: number, latencyMs: number, seconds: number) {
  const TICK = 1000 / 60;
  const sides = [0, 1].map(() => ({ tick: 0, acc: 0, lastRemote: NET.inputDelay, sync: new TimeSync(), started: false }));
  const wires: { at: number; lastInput: number; adv: number }[][] = [[], []];
  const gaps: number[] = [];
  for (let now = 0; now <= seconds * 1000; now += 1) {
    sides.forEach((s, i) => {
      if (!s.started && now >= (i === 0 ? 0 : offsetMs)) s.started = true;
      if (!s.started) return;
      const inbox = wires[i]!;
      while (inbox.length > 0 && inbox[0]!.at <= now) {
        const m = inbox.shift()!;
        s.lastRemote = m.lastInput;
        s.sync.note(TimeSync.advantage(s.tick, s.lastRemote), m.adv);
      }
      s.acc += s.sync.rate();
      while (s.acc >= TICK && s.tick + 1 - s.lastRemote <= NET.maxPredict) {
        s.acc -= TICK;
        s.tick++;
        wires[1 - i]!.push({ at: now + latencyMs, lastInput: s.tick + NET.inputDelay, adv: TimeSync.advantage(s.tick, s.lastRemote) });
      }
      if (s.acc > TICK) s.acc = TICK;
    });
    if (now % 100 === 0 && now >= offsetMs) gaps.push(sides[0]!.tick - sides[1]!.tick);
  }
  return { sides, gaps };
}

describe('TimeSync (online spec §3.3)', () => {
  it('two clocks started 20 ticks apart meet within a tick in a few seconds, at any latency', () => {
    for (const latency of [5, 40, 120]) {
      const { gaps } = run(333, latency, 8);
      const late = gaps.slice(-20);
      expect(Math.max(...late.map(Math.abs)), `latency ${latency}`).toBeLessThanOrEqual(1);
    }
  });

  it('two clocks started together never slow down', () => {
    const { sides } = run(0, 40, 5);
    for (const s of sides) expect(s.sync.rate()).toBe(1);
    expect(Math.abs(sides[0]!.tick - sides[1]!.tick)).toBeLessThanOrEqual(1);
    expect(sides[0]!.tick).toBeGreaterThanOrEqual(298);
  });

  it('estimates the lead whatever the latency: half the difference of the two advantages', () => {
    const t = new TimeSync();
    expect(t.ahead).toBe(0);
    t.note(10, 6); // 2 ahead with a latency of 8
    expect(t.ahead).toBe(2);
    expect(t.rate()).toBeCloseTo(1 - 0.06 * 1.5, 9);
    for (let i = 0; i < 20; i++) t.note(5, 5);
    expect(t.ahead).toBe(0);
    expect(t.rate()).toBe(1);
  });

  it('slows in proportion to the lead, never below 0.85', () => {
    const t = new TimeSync();
    t.note(1.5, 0.5); // half a tick ahead: left alone
    expect(t.rate()).toBe(1);
    const far = new TimeSync();
    far.note(80, 0);
    expect(far.rate()).toBe(0.85);
  });

  it('a side behind never slows', () => {
    const t = new TimeSync();
    for (let i = 0; i < 10; i++) t.note(2, 20);
    expect(t.ahead).toBeLessThan(0);
    expect(t.rate()).toBe(1);
  });
});
