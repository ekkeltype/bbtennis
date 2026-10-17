import { describe, expect, it } from 'vitest';
import { replay, simulateMatch } from '../../src/arcade/core/sim';
import type { ArcadeConfig } from '../../src/arcade/core/types';
import { ofType } from './matchHelpers';

const TIEBREAK: ArcadeConfig = { format: 'tiebreak', deuceRule: 'advantage', surface: 'hard', pace: 'normal' };
const GREEN = 6;

describe('simulateMatch', () => {
  it('Green vs Green in the tiebreak format plays to the end, with a winner and one record per point', () => {
    const r = simulateMatch(TIEBREAK, [GREEN, GREEN], 101);
    expect(r.state.status).toBe('over');
    expect(r.state.winner === 0 || r.state.winner === 1).toBe(true);
    expect(ofType(r.events, 'match')).toEqual([expect.objectContaining({ winner: r.state.winner })]);
    const points = ofType(r.events, 'point');
    expect(r.points).toHaveLength(points.length);
    expect(r.points.map((p) => [p.winner, p.reason])).toEqual(points.map((e) => [e.winner, e.reason]));
    const won = r.points.filter((p) => p.winner === r.state.winner).length;
    expect(won).toBeGreaterThanOrEqual(7);
    expect(r.inputs).toEqual([]); // not recorded unless asked
  });

  it('point records carry the server, the serve number, the hits (serve included) and the duration', () => {
    const r = simulateMatch(TIEBREAK, [GREEN, GREEN], 102);
    expect(r.points.length).toBeGreaterThan(0);
    for (const p of r.points) {
      expect([0, 1]).toContain(p.server);
      expect([1, 2]).toContain(p.serveNo);
      expect(Number.isInteger(p.hits) && p.hits >= 0).toBe(true);
      expect(Number.isInteger(p.ticks) && p.ticks > 0).toBe(true);
      if (p.reason === 'doubleFault') {
        expect(p.serveNo).toBe(2);
        expect(p.winner).not.toBe(p.server);
      }
      if (p.reason === 'ace') {
        expect(p.hits).toBe(1);
        expect(p.winner).toBe(p.server);
      }
    }
    // hits is the state's point.hits at the point's end: the hit events since the point's last set-up.
    let since = 0;
    const counted: number[] = [];
    for (const e of r.events) {
      if (e.type === 'setup') since = 0;
      if (e.type === 'hit') since += 1;
      if (e.type === 'point') counted.push(since);
    }
    expect(r.points.map((p) => p.hits)).toEqual(counted);
    expect(Math.max(...r.points.map((p) => p.hits))).toBe(r.state.longestRally);
  });

  it('stops at maxTicks', () => {
    const r = simulateMatch(TIEBREAK, [GREEN, GREEN], 103, { maxTicks: 900, record: true });
    expect(r.state.tick).toBe(900);
    expect(r.state.status).toBe('playing');
    expect(r.inputs).toHaveLength(900);
  });
});

describe('determinism', () => {
  it('recording a CPU-vs-CPU match, then replaying its inputs from the same seed, gives identical events and state', () => {
    const r = simulateMatch(TIEBREAK, [GREEN, 9], 104, { record: true });
    expect(r.inputs).toHaveLength(r.state.tick);
    const back = replay(TIEBREAK, r.state.players, 104, r.inputs);
    expect(back.events).toEqual(r.events);
    expect(back.state).toEqual(r.state);
  });

  it('two runs with the same seed are identical; different seeds differ', () => {
    const a = simulateMatch(TIEBREAK, [GREEN, GREEN], 105);
    const b = simulateMatch(TIEBREAK, [GREEN, GREEN], 105);
    expect(b.events).toEqual(a.events);
    expect(b.points).toEqual(a.points);
    expect(b.state).toEqual(a.state);
    const c = simulateMatch(TIEBREAK, [GREEN, GREEN], 106);
    expect(c.events).not.toEqual(a.events);
  });
});
