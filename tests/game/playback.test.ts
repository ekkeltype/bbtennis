import { describe, expect, it } from 'vitest';
import { seedRng, uniform } from '../../src/core/rng';
import { PlaybackClock } from '../../src/game/playback';

const ONLINE = { margin: 60, maxRate: 1.1, relaxMs: 500 };
const FRAME = 1000 / 60;

describe('PlaybackClock', () => {
  it('starts at τ_play = 0 and holds there with no confirmations', () => {
    const c = new PlaybackClock(ONLINE);
    c.begin();
    expect(c.τ).toBe(0);
    for (let i = 0; i < 600; i++) expect(c.tick(FRAME)).toBe(0);
  });

  it('holds at the latest confirmed τ once confirmations stop', () => {
    const c = new PlaybackClock(ONLINE);
    c.begin();
    c.confirm(400);
    for (let i = 0; i < 600; i++) c.tick(FRAME);
    expect(c.τ).toBe(400);
    c.tick(FRAME);
    expect(c.τ).toBe(400);
  });

  it('never exceeds the confirmed τ and never decreases, whatever the confirmations and frame times', () => {
    const rng = seedRng(17);
    const c = new PlaybackClock(ONLINE);
    c.begin();
    let confirmed = 0;
    let prev = 0;
    for (let i = 0; i < 5000; i++) {
      const r = uniform(rng);
      if (r < 0.3) {
        // Confirmations may jump ahead, repeat, or even arrive out of order (a lower τ).
        const τc = confirmed + (uniform(rng) - 0.2) * 300;
        c.confirm(τc);
        confirmed = Math.max(confirmed, τc);
      }
      const τ = c.tick(uniform(rng) * 120);
      expect(τ).toBeLessThanOrEqual(confirmed);
      expect(τ).toBeGreaterThanOrEqual(prev);
      expect(c.τ).toBe(τ);
      prev = τ;
    }
    expect(prev).toBeGreaterThan(0);
  });

  it('settles to margin ±20 ms behind confirmations that arrive 150 ms late at 20 Hz, within 1.5 s', () => {
    const c = new PlaybackClock(ONLINE);
    c.begin();
    // The owner's clock starts with ours; each 50 ms confirmation reaches us 150 ms later.
    let nextSent = 0;
    let confirmed = 0;
    const lags: { t: number; lag: number }[] = [];
    for (let frame = 1; frame * FRAME <= 4000; frame++) {
      const t = frame * FRAME;
      while (nextSent + 150 <= t) {
        confirmed = nextSent;
        c.confirm(confirmed);
        nextSent += 50;
      }
      lags.push({ t, lag: confirmed - c.tick(FRAME) });
    }
    // τ_c is a 50 ms staircase, so the lag is judged per confirmation period (three frames).
    const settled = lags.filter((l) => l.t >= 1500);
    for (let i = 0; i + 3 <= settled.length; i += 3) {
      const mean = (settled[i]!.lag + settled[i + 1]!.lag + settled[i + 2]!.lag) / 3;
      expect(Math.abs(mean - ONLINE.margin), `period starting at ${settled[i]!.t.toFixed(0)} ms`).toBeLessThanOrEqual(20);
    }
  });

  it('catches up at no more than maxRate when far behind', () => {
    const c = new PlaybackClock(ONLINE);
    c.begin();
    c.confirm(5000);
    let prev = 0;
    for (let i = 0; i < 60; i++) {
      const τ = c.tick(FRAME);
      expect(τ - prev).toBeLessThanOrEqual(ONLINE.maxRate * FRAME + 1e-9);
      expect(τ - prev).toBeGreaterThan(FRAME);
      prev = τ;
    }
  });

  it('with margin 0 plays exactly at a clock confirmed every frame (local CPU turns)', () => {
    const c = new PlaybackClock({ margin: 0, maxRate: 1.1, relaxMs: 500 });
    c.begin();
    for (let frame = 1; frame <= 300; frame++) {
      c.confirm(frame * FRAME);
      expect(c.tick(FRAME)).toBeCloseTo(frame * FRAME, 9);
    }
  });

  it('begin() restarts τ_play at 0 for the next turn', () => {
    const c = new PlaybackClock(ONLINE);
    c.begin();
    c.confirm(1000);
    for (let i = 0; i < 120; i++) c.tick(FRAME);
    expect(c.τ).toBeGreaterThan(0);
    c.begin();
    expect(c.τ).toBe(0);
  });

  it('ignores non-finite or negative frame times and non-finite confirmations', () => {
    const c = new PlaybackClock(ONLINE);
    c.begin();
    c.confirm(Number.NaN);
    c.confirm(Number.POSITIVE_INFINITY);
    expect(c.tick(FRAME)).toBe(0);
    c.confirm(500);
    expect(c.tick(Number.NaN)).toBe(0);
    expect(c.tick(-50)).toBe(0);
    expect(c.tick(Number.POSITIVE_INFINITY)).toBe(0);
    expect(c.tick(FRAME)).toBeGreaterThan(0);
  });

  it.each([
    { margin: -1, maxRate: 1.1, relaxMs: 500 },
    { margin: Number.NaN, maxRate: 1.1, relaxMs: 500 },
    { margin: 60, maxRate: 0, relaxMs: 500 },
    { margin: 60, maxRate: Number.POSITIVE_INFINITY, relaxMs: 500 },
    { margin: 60, maxRate: 1.1, relaxMs: 0 },
    { margin: 60, maxRate: 1.1, relaxMs: Number.NaN },
  ])('rejects options %o', (opts) => {
    expect(() => new PlaybackClock(opts)).toThrow(RangeError);
  });
});
