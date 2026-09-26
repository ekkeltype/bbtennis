import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealScheduler, VirtualScheduler } from '../../src/game/clock';

describe('VirtualScheduler', () => {
  it('starts at the given time (default 0) and advances now()', () => {
    expect(new VirtualScheduler().now()).toBe(0);
    const s = new VirtualScheduler(1000);
    expect(s.now()).toBe(1000);
    s.advance(250);
    expect(s.now()).toBe(1250);
  });

  it('after fires once, at its due time', () => {
    const s = new VirtualScheduler();
    const at: number[] = [];
    s.after(100, () => at.push(s.now()));
    s.advance(99);
    expect(at).toEqual([]);
    s.advance(1);
    expect(at).toEqual([100]);
    s.advance(1000);
    expect(at).toEqual([100]);
  });

  it('every fires at 50, 100 and 150 within advance(160)', () => {
    const s = new VirtualScheduler();
    const at: number[] = [];
    s.every(50, () => at.push(s.now()));
    s.advance(160);
    expect(at).toEqual([50, 100, 150]);
    expect(s.now()).toBe(160);
  });

  it('cancel stops an every timer', () => {
    const s = new VirtualScheduler();
    const at: number[] = [];
    const cancel = s.every(50, () => at.push(s.now()));
    s.advance(120);
    cancel();
    s.advance(500);
    expect(at).toEqual([50, 100]);
  });

  it('cancel stops a pending after timer', () => {
    const s = new VirtualScheduler();
    const fn = vi.fn();
    const cancel = s.after(100, fn);
    cancel();
    s.advance(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it('an every timer may cancel itself from inside its callback', () => {
    const s = new VirtualScheduler();
    const at: number[] = [];
    const cancel = s.every(10, () => {
      at.push(s.now());
      if (at.length === 2) cancel();
    });
    s.advance(100);
    expect(at).toEqual([10, 20]);
  });

  it('a callback may cancel another timer that is due in the same advance', () => {
    const s = new VirtualScheduler();
    const late = vi.fn();
    let cancelLate = (): void => {};
    s.after(10, () => cancelLate());
    cancelLate = s.after(20, late);
    s.advance(100);
    expect(late).not.toHaveBeenCalled();
  });

  it('runs callbacks scheduled inside a callback within the same advance when due', () => {
    const s = new VirtualScheduler();
    const at: string[] = [];
    s.after(10, () => {
      at.push(`outer@${s.now()}`);
      s.after(20, () => at.push(`inner@${s.now()}`));
      s.after(500, () => at.push(`later@${s.now()}`));
    });
    s.advance(100);
    expect(at).toEqual(['outer@10', 'inner@30']);
    s.advance(500);
    expect(at).toEqual(['outer@10', 'inner@30', 'later@510']);
  });

  it('now() inside a callback equals that callback\'s due time', () => {
    const s = new VirtualScheduler(5);
    const seen: number[] = [];
    s.after(7, () => seen.push(s.now()));
    s.after(33, () => seen.push(s.now()));
    s.every(20, () => seen.push(s.now()));
    s.advance(60);
    expect(seen).toEqual([12, 25, 38, 45, 65]);
  });

  it('runs callbacks in time order, ties in registration order', () => {
    const s = new VirtualScheduler();
    const order: string[] = [];
    s.after(30, () => order.push('a30'));
    s.every(10, () => order.push(`e${s.now()}`));
    s.after(10, () => order.push('b10'));
    s.after(10, () => order.push('c10'));
    s.after(0, () => order.push('d0'));
    s.advance(30);
    expect(order).toEqual(['d0', 'e10', 'b10', 'c10', 'e20', 'a30', 'e30']);
  });

  it('after(0) fires on the next advance, even advance(0)', () => {
    const s = new VirtualScheduler(40);
    const at: number[] = [];
    s.after(0, () => at.push(s.now()));
    expect(at).toEqual([]);
    s.advance(0);
    expect(at).toEqual([40]);
  });

  it('rejects intervals and advances that would hang or run time backwards', () => {
    const s = new VirtualScheduler();
    expect(() => s.every(0, () => {})).toThrow(RangeError);
    expect(() => s.every(Number.NaN, () => {})).toThrow(RangeError);
    expect(() => s.advance(-1)).toThrow(RangeError);
    expect(() => s.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('RealScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('now() is a finite, non-decreasing millisecond clock', () => {
    const s = new RealScheduler();
    const a = s.now();
    const b = s.now();
    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('after fires once after the delay and can be cancelled', () => {
    vi.useFakeTimers();
    const s = new RealScheduler();
    const fired = vi.fn();
    const cancelled = vi.fn();
    s.after(100, fired);
    const cancel = s.after(100, cancelled);
    cancel();
    vi.advanceTimersByTime(99);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('every repeats until cancelled', () => {
    vi.useFakeTimers();
    const s = new RealScheduler();
    const fn = vi.fn();
    const cancel = s.every(50, fn);
    vi.advanceTimersByTime(160);
    expect(fn).toHaveBeenCalledTimes(3);
    cancel();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
