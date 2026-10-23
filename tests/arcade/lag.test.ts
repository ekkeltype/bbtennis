import { describe, expect, it } from 'vitest';
import { laggy } from '../../src/arcade/game/lag';
import { seedRng, uniform } from '../../src/core/rng';
import { VirtualScheduler } from '../../src/game/clock';
import type { Transport } from '../../src/net/channel';

/** A transport that records when each message (and the close) reached it. */
function recorder(s: VirtualScheduler): Transport<number> & { got: { at: number; m: number | 'close' }[] } {
  const got: { at: number; m: number | 'close' }[] = [];
  return {
    got,
    send: (m) => void got.push({ at: s.now(), m }),
    onMessage: () => {},
    onClose: () => {},
    close: () => void got.push({ at: s.now(), m: 'close' }),
    bufferedAmount: 0,
  };
}

describe('laggy (online spec §1.2 debug lag)', () => {
  it('holds every message back 75–125 % of the lag and lets them out in send order, then the close', () => {
    const s = new VirtualScheduler();
    const inner = recorder(s);
    const r = seedRng(4);
    const t = laggy(inner, 60, s, () => uniform(r));
    const sentAt: number[] = [];
    for (let i = 0; i < 200; i++) {
      sentAt.push(s.now());
      t.send(i);
      s.advance(i % 3 === 0 ? 0 : 0.37);
    }
    t.close();
    s.advance(200);
    expect(inner.got.map((g) => g.m)).toEqual([...Array.from({ length: 200 }, (_, i) => i), 'close']);
    inner.got.slice(0, 200).forEach((g, i) => {
      expect(g.at - sentAt[i]!).toBeGreaterThanOrEqual(45 - 1e-9);
    });
    expect(Math.max(...inner.got.slice(0, 200).map((g, i) => g.at - sentAt[i]!))).toBeLessThanOrEqual(75 + 1e-9);
  });

  it('passes what arrives through untouched', () => {
    const s = new VirtualScheduler();
    let cb: ((m: number) => void) | null = null;
    const inner: Transport<number> = { send: () => {}, onMessage: (c) => void (cb = c), onClose: () => {}, close: () => {}, bufferedAmount: 3 };
    const t = laggy(inner, 60, s);
    const got: number[] = [];
    t.onMessage((m) => got.push(m));
    cb!(7);
    expect(got).toEqual([7]);
    expect(t.bufferedAmount).toBe(3);
  });
});
