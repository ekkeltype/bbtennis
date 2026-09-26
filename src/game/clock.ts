/** Time source + timers. Real in the browser, virtual in tests. */
export interface Scheduler {
  /** Current time in ms; monotonic. */
  now(): number;
  /** Calls `fn` every `ms` milliseconds; returns a cancel function. */
  every(ms: number, fn: () => void): () => void;
  /** Calls `fn` once after `ms` milliseconds; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
}

/** performance.now + setInterval/setTimeout. */
export class RealScheduler implements Scheduler {
  now(): number {
    return performance.now();
  }

  every(ms: number, fn: () => void): () => void {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }

  after(ms: number, fn: () => void): () => void {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  }
}

interface VirtualTimer {
  seq: number;
  due: number;
  period: number | null;
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

  /** Throws RangeError unless `ms` is finite and > 0 (a zero period would never let time advance). */
  every(ms: number, fn: () => void): () => void {
    if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`every: interval must be a finite number > 0, got ${ms}`);
    return this.add(ms, ms, fn);
  }

  /** Negative delays fire at the current time, like setTimeout. */
  after(ms: number, fn: () => void): () => void {
    return this.add(Math.max(0, ms), null, fn);
  }

  /** Advances time by ms, running due callbacks in time order (ties: registration order), including callbacks scheduled during the advance. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance: ms must be a finite number >= 0, got ${ms}`);
    const end = this.time + ms;
    for (let timer = this.nextDue(end); timer !== null; timer = this.nextDue(end)) {
      this.time = timer.due;
      if (timer.period === null) this.remove(timer);
      else timer.due += timer.period;
      timer.fn();
    }
    this.time = end;
  }

  private add(delay: number, period: number | null, fn: () => void): () => void {
    const timer: VirtualTimer = { seq: this.nextSeq++, due: this.time + delay, period, fn };
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
      if (t.due > end) continue;
      if (best === null || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  }
}
