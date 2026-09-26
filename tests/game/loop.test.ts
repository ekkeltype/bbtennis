import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealScheduler } from '../../src/game/clock';
import { MAX_FRAME_DT_MS, startLoop, workerTicker } from '../../src/game/loop';

/** A stand-in for the browser's Worker: records its script URL and lets the test post or fail. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  terminated = false;
  constructor(readonly url: string) {
    FakeWorker.all.push(this);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Simulates the worker posting one tick. */
  tick(): void {
    if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: 0 }));
  }
  /** Simulates the worker failing to load (e.g. a CSP that blocks blob: workers). */
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

describe('startLoop', () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    callbacks = new Map();
    nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.set(nextId, cb);
      return nextId++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs the pending animation frame at time `t`. */
  function runFrame(t: number): void {
    const pending = [...callbacks.entries()];
    callbacks.clear();
    for (const [, cb] of pending) cb(t);
  }

  it('calls onFrame once per animation frame with the time since the previous frame, capped', () => {
    const dts: number[] = [];
    startLoop((dt) => dts.push(dt));
    runFrame(1000);
    runFrame(1016.5);
    runFrame(1050);
    runFrame(3050);
    runFrame(3040);
    expect(dts).toEqual([0, 16.5, 33.5, MAX_FRAME_DT_MS, 0]);
  });

  it('stop() cancels the pending frame and no frame runs after it', () => {
    const onFrame = vi.fn();
    const stop = startLoop(onFrame);
    runFrame(0);
    stop();
    expect(callbacks.size).toBe(0);
    runFrame(16);
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('keeps running when a frame throws', () => {
    let calls = 0;
    startLoop(() => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    expect(() => runFrame(0)).toThrow('boom');
    runFrame(16);
    expect(calls).toBe(2);
  });
});

describe('workerTicker', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to setInterval when Worker is unavailable', () => {
    vi.stubGlobal('Worker', undefined);
    const fn = vi.fn();
    const stop = workerTicker(50, fn);
    vi.advanceTimersByTime(160);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('runs a Blob URL worker that posts every `ms`, calls fn per message, and cleans up on stop', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const created = vi.spyOn(URL, 'createObjectURL');
    const revoked = vi.spyOn(URL, 'revokeObjectURL');
    const fn = vi.fn();
    const stop = workerTicker(50, fn);
    expect(FakeWorker.all).toHaveLength(1);
    const worker = FakeWorker.all[0]!;
    const blob = created.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toContain('setInterval(() => postMessage(0), 50)');
    expect(worker.url).toBe(created.mock.results[0]!.value);
    worker.tick();
    worker.tick();
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    expect(worker.terminated).toBe(true);
    expect(revoked).toHaveBeenCalledWith(worker.url);
    worker.tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('falls back to setInterval when creating the worker throws', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('SecurityError');
        }
      },
    );
    const fn = vi.fn();
    const stop = workerTicker(20, fn);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(5);
    stop();
  });

  it('switches to setInterval when the worker fails to load', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const fn = vi.fn();
    const stop = workerTicker(25, fn);
    const worker = FakeWorker.all[0]!;
    worker.fail();
    expect(worker.terminated).toBe(true);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects the period %s', (ms) => {
    expect(() => workerTicker(ms, () => {})).toThrow(RangeError);
  });
});

describe('RealScheduler({ worker: true })', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs every() on a worker ticker', () => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
    const fn = vi.fn();
    const cancel = new RealScheduler({ worker: true }).every(50, fn);
    expect(FakeWorker.all).toHaveLength(1);
    FakeWorker.all[0]!.tick();
    expect(fn).toHaveBeenCalledTimes(1);
    cancel();
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it('still rejects a bad period', () => {
    vi.stubGlobal('Worker', FakeWorker);
    expect(() => new RealScheduler({ worker: true }).every(0, () => {})).toThrow(RangeError);
  });
});
