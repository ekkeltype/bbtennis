import { seedRng, uniform } from '../core/rng';
import type { Scheduler } from '../game/clock';
import { parseMsg, type NetMsg } from './protocol';

/** A reliable, ordered message channel to the other player (spec §5.3). */
export interface Transport {
  /** Sends a message; a no-op once the transport is closed. */
  send(msg: NetMsg): void;
  /** Adds a listener for incoming messages; messages that fail `parseMsg` are dropped. */
  onMessage(cb: (m: NetMsg) => void): void;
  /** Adds a listener for the remote side closing or the connection failing; not called after a local `close()`. */
  onClose(cb: (reason: string) => void): void;
  /** Closes the channel after the messages already sent; idempotent. */
  close(): void;
  /** Bytes queued locally that have not been handed to the network yet. */
  readonly bufferedAmount: number;
}

/** Latency model of `loopbackPair`: each message takes latencyMs + U[0, 1)·jitterMs one way. */
export interface LoopbackOptions { latencyMs: number; jitterMs: number; seed: number }

/** Reason reported by `onClose` when the other side closed the channel. */
export const REMOTE_CLOSED = 'closed';

type Packet = { json: string } | 'close';

/** One end of a loopback pair; `peer` is the other end. */
class LoopbackEnd implements Transport {
  peer: LoopbackEnd | null = null;
  readonly bufferedAmount = 0;
  private closed = false;
  private readonly messageCbs: ((m: NetMsg) => void)[] = [];
  private readonly closeCbs: ((reason: string) => void)[] = [];
  /** Packets travelling towards this end, in send order. */
  private readonly inbound: Packet[] = [];
  private lastDue = Number.NEGATIVE_INFINITY;

  constructor(private readonly s: Scheduler, private readonly delay: () => number) {}

  send(msg: NetMsg): void {
    if (!this.closed) this.peer?.enqueue({ json: JSON.stringify(msg) });
  }

  onMessage(cb: (m: NetMsg) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer?.enqueue('close');
  }

  /** Schedules `p` for delivery here; it never overtakes an earlier packet. */
  private enqueue(p: Packet): void {
    const now = this.s.now();
    const due = Math.max(now + this.delay(), this.lastDue);
    this.lastDue = due;
    this.inbound.push(p);
    this.s.after(due - now, () => this.deliverNext());
  }

  /** Delivers the oldest packet in flight, so order holds whatever order the timers fire in. */
  private deliverNext(): void {
    const p = this.inbound.shift();
    if (p === undefined || this.closed) return;
    if (p === 'close') {
      this.closed = true;
      for (const cb of this.closeCbs) cb(REMOTE_CLOSED);
      return;
    }
    const msg = parseMsg(JSON.parse(p.json));
    if (msg) for (const cb of this.messageCbs) cb(msg);
  }
}

/**
 * Two connected in-memory transports driven by `s`, for tests and headless sessions. Messages go
 * through JSON and `parseMsg` like the real wire and arrive in send order; the jitter stream is
 * seeded, so a run is reproducible. Throws RangeError unless latencyMs and jitterMs are finite and ≥ 0.
 */
export function loopbackPair(s: Scheduler, opts: LoopbackOptions): [Transport, Transport] {
  const { latencyMs, jitterMs } = opts;
  if (!(Number.isFinite(latencyMs) && latencyMs >= 0 && Number.isFinite(jitterMs) && jitterMs >= 0)) {
    throw new RangeError(`loopbackPair: latencyMs and jitterMs must be finite and >= 0, got ${latencyMs} and ${jitterMs}`);
  }
  const rng = seedRng(opts.seed);
  const delay = (): number => latencyMs + uniform(rng) * jitterMs;
  const a = new LoopbackEnd(s, delay);
  const b = new LoopbackEnd(s, delay);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
