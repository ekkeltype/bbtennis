import type { Scheduler } from '../game/clock';
import { TransportListeners, type Transport } from './channel';
import { wireBytes } from './codec';

/** The heartbeat's own messages (spec §5.3); every protocol a PeerLink carries includes all three. */
export type LinkMsg = { type: 'ping'; id: number } | { type: 'pong'; id: number } | { type: 'leave' };

/** How the opponent went away: a `leave` message, or a closed or silent link. */
export type Departure = 'left' | 'disconnect';

/** Heartbeat (spec §5.3): a ping every 2 s; 3 s of silence is unstable, 8 s a disconnect. */
const PING_MS = 2000;
const UNSTABLE_MS = 3000;
const DISCONNECT_MS = 8000;

/**
 * The one place the link's own messages meet a protocol's messages `M`. `M`'s union includes LinkMsg
 * (a PeerLink requires it), which TypeScript cannot check for a type parameter: `asMsg` casts a link
 * message on its way out, and `asLink` reads a received message as one when its type is ping, pong or
 * leave (null for every other message).
 */
const asMsg = <M>(m: LinkMsg): M => m as unknown as M;
const asLink = (m: { type: string }): LinkMsg | null => (m.type === 'ping' || m.type === 'pong' || m.type === 'leave' ? (m as LinkMsg) : null);

/**
 * The link to the other player (spec §5.3 heartbeat), for a protocol's messages `M`, whose union must
 * include LinkMsg's ping, pong and leave. It takes nothing from the transport until `listen`. Any
 * message counts as liveness: 3 s of silence make the link unstable, and 8 s of silence, a transport
 * close or error, or a `leave` lose the opponent (reported once through `gone`). It pings every 2 s,
 * answers pings and keeps the latest round trip. Every other message goes to `message`. After a local
 * `leave` or `close` it sends and reports nothing more.
 */
export class PeerLink<M extends { type: string }> {
  private lastHeard: number;
  private lastPingAt: number;
  private nextPingId = 0;
  private pendingPing: { id: number; at: number } | null = null;
  private rtt: number | null = null;
  private lost: Departure | null = null;
  private quiet = false;
  private listening = false;

  constructor(
    private readonly transport: Transport<M>,
    private readonly scheduler: Scheduler,
    private readonly handlers: { message(m: M): void; gone(why: Departure): void },
  ) {
    const now = scheduler.now();
    this.lastHeard = now;
    this.lastPingAt = now;
  }

  /**
   * Starts taking the transport's messages and its close (once). A transport hands over what arrived
   * before its first listener synchronously, here, so the handlers must be ready for it.
   */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    const now = this.scheduler.now();
    this.lastHeard = now;
    this.lastPingAt = now;
    this.transport.onMessage((m) => this.receive(m));
    this.transport.onClose(() => this.lose('disconnect'));
  }

  /** How the opponent went away, or null while the link is up. */
  get gone(): Departure | null {
    return this.lost;
  }

  /** Latest ping round trip (ms), or null before the first pong. */
  get rttMs(): number | null {
    return this.rtt;
  }

  /** Bytes sent that have not left yet. */
  get bufferedAmount(): number {
    return this.transport.bufferedAmount;
  }

  /** True after 3 s without a message while the opponent is still there. */
  unstable(now: number): boolean {
    return this.lost === null && now - this.lastHeard >= UNSTABLE_MS;
  }

  /** Sends `m` unless the opponent has gone or this side has left. */
  send(m: M): void {
    if (this.lost === null && !this.quiet) this.transport.send(m);
  }

  /** Heartbeat: a disconnect after 8 s of silence, otherwise a ping every 2 s. */
  tick(now: number): void {
    if (this.lost !== null || this.quiet) return;
    if (now - this.lastHeard >= DISCONNECT_MS) {
      this.lose('disconnect');
      return;
    }
    if (now - this.lastPingAt < PING_MS) return;
    this.lastPingAt = now;
    this.pendingPing = { id: this.nextPingId++, at: now };
    this.send(asMsg({ type: 'ping', id: this.pendingPing.id }));
  }

  /** Tells the opponent this side leaves (once, if it is still there); the link then stays quiet. */
  leave(): void {
    this.send(asMsg({ type: 'leave' }));
    this.quiet = true;
  }

  /** Closes the transport after the messages already sent. */
  close(): void {
    this.quiet = true;
    this.transport.close();
  }

  private receive(m: M): void {
    if (this.lost !== null || this.quiet) return;
    const now = this.scheduler.now();
    this.lastHeard = now;
    const own = asLink(m);
    switch (own?.type) {
      case 'ping':
        this.send(asMsg({ type: 'pong', id: own.id }));
        return;
      case 'pong':
        if (this.pendingPing?.id === own.id) {
          this.rtt = now - this.pendingPing.at;
          this.pendingPing = null;
        }
        return;
      case 'leave':
        this.lose('left');
        return;
      default:
        this.handlers.message(m);
    }
  }

  private lose(why: Departure): void {
    if (this.lost !== null || this.quiet) return;
    this.lost = why;
    this.handlers.gone(why);
  }
}

/**
 * One owner's view of a switched transport: it hears the transport only while it is the switch's
 * current channel. What it holds for its first listener is measured as on the wire (wireBytes).
 */
class Channel<M> implements Transport<M> {
  readonly listeners = new TransportListeners<M>(wireBytes);
  current = true;

  constructor(private readonly inner: Transport<M>) {}

  get bufferedAmount(): number {
    return this.inner.bufferedAmount;
  }

  send(msg: M): void {
    if (this.current) this.inner.send(msg);
  }

  onMessage(cb: (m: M) => void): void {
    this.listeners.onMessage(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.listeners.onClose(cb);
  }

  close(): void {
    if (this.current) this.inner.close();
  }
}

/**
 * Hands one transport from owner to owner: from the lobby to the match session (spec §5.3). A
 * Transport cannot drop a listener, so the switch listens to it once and passes each message and the
 * close to its current channel only. Once `next()` makes a new channel current, the old one hears
 * nothing more and its `send` and `close` do nothing, so the lobby can neither answer nor close what
 * the match now owns. A channel holds what it is passed until it has listeners, like any transport.
 */
export class TransportSwitch<M> {
  private channel: Channel<M>;
  private closedWith: string | null = null;

  constructor(private readonly inner: Transport<M>) {
    this.channel = new Channel(inner);
    inner.onMessage((m) => this.channel.listeners.message(m));
    inner.onClose((reason) => {
      this.closedWith = reason;
      this.channel.listeners.close(reason);
    });
  }

  /** The channel that hears the transport now. */
  get current(): Transport<M> {
    return this.channel;
  }

  /** Makes a new channel current and returns it; it hears `first` before anything else, then the transport (and a close that already happened). */
  next(first: readonly M[] = []): Transport<M> {
    this.channel.current = false;
    const ch = new Channel(this.inner);
    this.channel = ch;
    for (const m of first) ch.listeners.message(m);
    if (this.closedWith !== null) ch.listeners.close(this.closedWith);
    return ch;
  }
}

/** How often the lobby's heartbeat runs. */
const LOBBY_TICK_MS = 250;

/**
 * The link to the other player in the lobby: a PeerLink (spec §5.3 heartbeat: pings, the round trip,
 * the other side leaving, closing or going silent) on a TransportSwitch's first channel, ticking every
 * 250 ms from `open` until `handOver` gives the transport to the match. Its handlers take the other
 * side's lobby messages and hear once that it has gone. `M`'s union must include LinkMsg (see PeerLink).
 */
export class LobbyLink<M extends { type: string }> {
  private readonly switch: TransportSwitch<M>;
  private readonly link: PeerLink<M>;
  private readonly scheduler: Scheduler;
  private stopTick: (() => void) | null = null;

  constructor(transport: Transport<M>, scheduler: Scheduler, handlers: { message(m: M): void; gone(why: Departure): void }) {
    this.scheduler = scheduler;
    this.switch = new TransportSwitch(transport);
    this.link = new PeerLink(this.switch.current, scheduler, handlers);
  }

  /** Starts hearing the other side (what arrived earlier comes now, so the handlers must be ready) and the heartbeat; once. */
  open(): void {
    if (this.stopTick !== null) return;
    this.link.listen();
    this.stopTick = this.scheduler.every(LOBBY_TICK_MS, () => this.link.tick(this.scheduler.now()));
  }

  /** Latest ping round trip (ms), or null before the first pong. */
  get rttMs(): number | null {
    return this.link.rttMs;
  }

  /** Sends `m` while the other side is there and the lobby has the transport. */
  send(m: M): void {
    this.link.send(m);
  }

  /** The match takes the transport over: the lobby's heartbeat stops and hears nothing more; the match's channel hears `first` first. */
  handOver(first: readonly M[] = []): Transport<M> {
    this.stop();
    return this.switch.next(first);
  }

  /** Leaves the lobby: the other side is told (once) and the transport closes after it. */
  close(): void {
    this.stop();
    this.link.leave();
    this.link.close();
  }

  private stop(): void {
    this.stopTick?.();
    this.stopTick = () => {};
  }
}
