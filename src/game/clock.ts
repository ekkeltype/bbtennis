/** Time source + timers. Real in the browser, virtual in tests. */
export interface Scheduler {
  /** Current time in ms; monotonic. */
  now(): number;
  /** Calls `fn` every `ms` milliseconds; returns a cancel function. Throws RangeError unless `ms` is finite and > 0. */
  every(ms: number, fn: () => void): () => void;
  /** Calls `fn` once after `ms` milliseconds; returns a cancel function. NaN, ±Infinity and negative `ms` mean 0. */
  after(ms: number, fn: () => void): () => void;
}

/** The delay `after` actually uses: `ms` when finite and positive, else 0. */
function afterDelay(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Throws RangeError unless `ms` is a usable `every` period (a zero period would never let time advance). */
function checkPeriod(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`every: period must be a finite number > 0, got ${ms}`);
}

/** performance.now + setInterval/setTimeout. */
export class RealScheduler implements Scheduler {
  now(): number {
    return performance.now();
  }

  every(ms: number, fn: () => void): () => void {
    checkPeriod(ms);
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }

  after(ms: number, fn: () => void): () => void {
    const id = setTimeout(fn, afterDelay(ms));
    return () => clearTimeout(id);
  }
}

/** A timer due at most this far past the end of an advance still fires in it, at the end, so float rounding in origin + k * period never drops a tick. */
const DUE_SLACK_MS = 1e-6;

interface VirtualTimer {
  seq: number;
  /** Time the timer was created; periodic tick k is due at origin + k * period (no accumulated drift). */
  origin: number;
  /** Null for a one-shot timer. */
  period: number | null;
  /** Index of the next periodic tick (starts at 1). */
  tick: number;
  due: number;
  fn: () => void;
}

/** Deterministic scheduler for tests. */
export class VirtualScheduler implements Scheduler {
  private time: number;
  private nextSeq = 0;
  private timers: VirtualTimer[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  every(ms: number, fn: () => void): () => void {
    checkPeriod(ms);
    return this.add(ms, ms, fn);
  }

  after(ms: number, fn: () => void): () => void {
    return this.add(afterDelay(ms), null, fn);
  }

  /** Advances time by ms, running due callbacks in time order (ties: registration order), including callbacks scheduled during the advance. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance: ms must be a finite number >= 0, got ${ms}`);
    const end = this.time + ms;
    for (let timer = this.nextDue(end); timer !== null; timer = this.nextDue(end)) {
      this.time = Math.min(timer.due, end);
      if (timer.period === null) {
        this.remove(timer);
      } else {
        timer.tick += 1;
        timer.due = timer.origin + timer.tick * timer.period;
      }
      timer.fn();
    }
    this.time = end;
  }

  private add(delay: number, period: number | null, fn: () => void): () => void {
    const timer: VirtualTimer = { seq: this.nextSeq++, origin: this.time, period, tick: 1, due: this.time + delay, fn };
    this.timers.push(timer);
    return () => this.remove(timer);
  }

  private remove(timer: VirtualTimer): void {
    const i = this.timers.indexOf(timer);
    if (i >= 0) this.timers.splice(i, 1);
  }

  private nextDue(end: number): VirtualTimer | null {
    let best: VirtualTimer | null = null;
    for (const t of this.timers) {
      if (t.due > end + DUE_SLACK_MS) continue;
      if (best === null || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  }
}
