import { seedRng, uniform } from '../core/rng';
import type { Scheduler } from '../game/clock';
import { decodeMsg, encodeWithBytes, msgBytes, type EncodedMsg, type NetMsg } from './protocol';

/** A reliable, ordered message channel to the other player (spec §5.3). */
export interface Transport {
  /**
   * Sends a message as JSON; a no-op once the transport is closed. A message over MAX_SEND_BYTES
   * (see msgBytes) is dropped with a `[bbt] frame too big` warning, and the channel stays open.
   */
  send(msg: NetMsg): void;
  /**
   * Adds a listener for incoming messages; messages that fail `parseMsg` are dropped. Messages that
   * arrive before the first listener is added are held and handed to it when it is added, up to
   * MAX_HELD_MESSAGES messages or MAX_HELD_BYTES bytes; later ones are dropped with a warning.
   */
  onMessage(cb: (m: NetMsg) => void): void;
  /**
   * Adds a listener for the remote side closing or the connection failing; not called after a local
   * `close()`. A close that happens before the first listener is added is reported to it when it is
   * added, but never ahead of a message that arrived before it: while such messages are held for the
   * first onMessage listener, the close waits until they have been handed over.
   */
  onClose(cb: (reason: string) => void): void;
  /** Closes the channel after the messages already sent; idempotent. Held messages are dropped. */
  close(): void;
  /**
   * Bytes sent that have not left yet: the data channel's send queue for PeerJS; for the loopback,
   * the UTF-8 bytes of the JSON of this end's messages still in flight.
   */
  readonly bufferedAmount: number;
}

/** Latency model of `loopbackPair`: each message takes latencyMs + U[0, 1)·jitterMs one way. */
export interface LoopbackOptions { latencyMs: number; jitterMs: number; seed: number }

/** Reason reported by `onClose` when the other side closed the channel. */
export const REMOTE_CLOSED = 'closed';

/** Most messages a transport holds for its first message listener (see TransportListeners). */
export const MAX_HELD_MESSAGES = 64;

/** Most UTF-8 bytes of JSON (see msgBytes) of the messages a transport holds for its first message listener. */
export const MAX_HELD_BYTES = 64 * 1024;

/**
 * The message and close listeners of a transport. Until the first listener of each kind is added,
 * incoming messages and the close reason are held for it, so a listener added late misses nothing.
 * The close is reported only after every held message has been handed over, whichever listener
 * comes first. At most MAX_HELD_MESSAGES messages and MAX_HELD_BYTES bytes are held: the first
 * message over either cap is dropped with one `[bbt]` warning, and so is every later one until the
 * first message listener is added, so the held messages are always the first ones that arrived.
 */
export class TransportListeners {
  private readonly messageCbs: ((m: NetMsg) => void)[] = [];
  private readonly closeCbs: ((reason: string) => void)[] = [];
  private held: NetMsg[] = [];
  private heldBytes = 0;
  private overflowed = false;
  private heldClose: string | null = null;

  /** Adds a message listener; the first one gets the held messages at once (until dropHeld), then the held close. */
  onMessage(cb: (m: NetMsg) => void): void {
    this.messageCbs.push(cb);
    if (this.messageCbs.length > 1) return;
    while (this.held.length > 0) cb(this.held.shift()!);
    this.heldBytes = 0;
    this.releaseClose();
  }

  /** Adds a close listener; it is told at once if the close already happened and no messages are still held. */
  onClose(cb: (reason: string) => void): void {
    this.closeCbs.push(cb);
    this.releaseClose();
  }

  /** Hands an incoming message to the listeners, or holds it until there is one (within the caps). */
  message(m: NetMsg): void {
    if (this.messageCbs.length === 0) this.hold(m);
    else for (const cb of this.messageCbs) cb(m);
  }

  /** Reports the remote close or a failure to the listeners, holding it while it has none or messages are held. */
  close(reason: string): void {
    this.heldClose = reason;
    this.releaseClose();
  }

  /** Reports the held close to the close listeners there are, once no message is held before it. */
  private releaseClose(): void {
    const reason = this.heldClose;
    if (reason === null || this.closeCbs.length === 0 || this.held.length > 0) return;
    this.heldClose = null;
    for (const cb of this.closeCbs) cb(reason);
  }

  /** Drops the held messages; after a local close nothing more is delivered. */
  dropHeld(): void {
    this.held = [];
    this.heldBytes = 0;
  }

  /** Holds `m` for the first message listener, or drops it once the held messages have reached a cap. */
  private hold(m: NetMsg): void {
    if (this.overflowed) return;
    const bytes = msgBytes(m);
    if (this.held.length < MAX_HELD_MESSAGES && this.heldBytes + bytes <= MAX_HELD_BYTES) {
      this.held.push(m);
      this.heldBytes += bytes;
      return;
    }
    this.overflowed = true;
    console.warn('[bbt] held messages over the cap, dropping the rest', this.held.length, this.heldBytes);
  }
}

type Packet = EncodedMsg | 'close';

/** One end of a loopback pair; `peer` is the other end. */
class LoopbackEnd implements Transport {
  peer: LoopbackEnd | null = null;
  private closed = false;
  private readonly listeners = new TransportListeners();
  /** Packets travelling towards this end, in send order, and the bytes of their messages. */
  private readonly inbound: Packet[] = [];
  private inboundBytes = 0;
  private lastDue = Number.NEGATIVE_INFINITY;

  constructor(private readonly s: Scheduler, private readonly delay: () => number) {}

  get bufferedAmount(): number {
    return this.peer?.inboundBytes ?? 0;
  }

  send(msg: NetMsg): void {
    if (this.closed) return;
    const encoded = encodeWithBytes(msg);
    if (encoded) this.peer?.enqueue(encoded);
  }

  onMessage(cb: (m: NetMsg) => void): void {
    this.listeners.onMessage(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.listeners.onClose(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.dropHeld();
    this.peer?.enqueue('close');
  }

  /** Schedules `p` for delivery here; it never overtakes an earlier packet. */
  private enqueue(p: Packet): void {
    const now = this.s.now();
    const due = Math.max(now + this.delay(), this.lastDue);
    this.lastDue = due;
    this.inbound.push(p);
    if (p !== 'close') this.inboundBytes += p.bytes;
    this.s.after(due - now, () => this.deliverNext());
  }

  /** Delivers the oldest packet in flight, so order holds whatever order the timers fire in. */
  private deliverNext(): void {
    const p = this.inbound.shift();
    if (p === undefined) return;
    if (p !== 'close') this.inboundBytes -= p.bytes;
    if (this.closed) return;
    if (p === 'close') {
      this.closed = true;
      this.listeners.close(REMOTE_CLOSED);
      return;
    }
    const msg = decodeMsg(p.json);
    if (msg) this.listeners.message(msg);
  }
}

/**
 * Two connected in-memory transports driven by `s`, for tests and headless sessions. Messages cross
 * the same JSON wire as the PeerJS transport (encodeMsg/decodeMsg, so the MAX_SEND_BYTES cap too)
 * and arrive in send order; the jitter stream is seeded, so a run is reproducible.
 * Throws RangeError unless latencyMs and jitterMs are finite and ≥ 0.
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
