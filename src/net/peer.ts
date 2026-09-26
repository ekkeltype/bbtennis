import { RealScheduler, type Scheduler } from '../game/clock';
import { genCode, normalizeCode } from './codes';
import { NetError, errorKind, type NetErrorKind } from './netErrors';
import { peerOptions, type BrokerOptions, type PeerEnvVars } from './peerConfig';
import { decodeMsg, encodeMsg } from './protocol';
import { REMOTE_CLOSED, TransportListeners, type Transport } from './transport';

export { NetError, errorKind, errorText, type NetErrorKind } from './netErrors';
export { DEFAULT_ICE_SERVERS, peerOptions, type BrokerOptions, type PeerEnvVars } from './peerConfig';

/** Prefix of every host's PeerJS id; the rest is the game code. */
export const PEER_ID_PREFIX = 'bbtennis-';

/** Codes a host tries when the broker says the id is taken (spec §5.3). */
export const HOST_CODE_TRIES = 5;

/** Time allowed to reach the broker (host) or open the connection (guest) (spec §5.4). */
export const JOIN_TIMEOUT_MS = 20000;

/** Delay before a join reports STILL_CONNECTING (spec §5.4). */
export const SLOW_STATUS_MS = 5000;

/** A closing transport waits this long, so the messages it already sent can arrive, before it closes the connection (spec §5.3). */
export const CLOSE_FLUSH_MS = 500;

/** Delay before a host that lost the broker re-registers its code. */
export const RECONNECT_DELAY_MS = 2000;

/** Status reported by joinGame after SLOW_STATUS_MS. */
export const STILL_CONNECTING = 'Still connecting…';

/** A PeerJS error: `type` is a PeerErrorType or connection error type string. */
export interface PeerErrorLike { type: string; message: string }

/** The part of a PeerJS DataConnection used here; with raw serialization it carries strings as they are. */
export interface ConnLike {
  on(event: 'open', fn: () => void): unknown;
  on(event: 'data', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: PeerErrorLike) => void): unknown;
  send(data: string): unknown;
  close(): void;
  readonly dataChannel: { readonly bufferedAmount: number } | null | undefined;
}

/** The part of a PeerJS Peer used here. */
export interface PeerLike {
  on(event: 'open', fn: (id: string) => void): unknown;
  on(event: 'connection', fn: (conn: ConnLike) => void): unknown;
  on(event: 'disconnected', fn: () => void): unknown;
  on(event: 'error', fn: (err: PeerErrorLike) => void): unknown;
  connect(id: string, options: { reliable: boolean; serialization: string }): ConnLike;
  reconnect(): void;
  destroy(): void;
  readonly disconnected: boolean;
  readonly destroyed: boolean;
}

/** Creates a Peer with the given id (null = broker-assigned). */
export type PeerFactory = (id: string | null, options: BrokerOptions) => Promise<PeerLike>;

/** Environment of hostGame/joinGame; every field defaults to the real browser setup. */
export interface PeerEnv {
  /** Broker/ICE overrides; default import.meta.env. */
  env?: PeerEnvVars;
  /** Timer source; default RealScheduler. */
  scheduler?: Scheduler;
  /** Uniforms in [0, 1) for game codes; default Math.random. */
  rand?: () => number;
  /** Peer constructor; default PeerJS, loaded on first use. */
  createPeer?: PeerFactory;
  /** joinGame progress: called with STILL_CONNECTING after SLOW_STATUS_MS. */
  onStatus?: (text: string) => void;
  /**
   * Aborting it cancels a pending hostGame/joinGame: the peer is destroyed, the promise rejects with
   * NetError('cancelled') and a result that arrives afterwards is closed at once. No effect once the
   * promise has resolved.
   */
  signal?: AbortSignal;
}

/** A registered host waiting for guests. */
export interface HostHandle {
  /** The 5-character game code guests type. */
  code: string;
  /**
   * Sets the listener for guests whose connection is open; guests that arrived earlier and are still
   * connected are handed over at once. A guest's messages are held until its transport has a listener.
   */
  onGuest(cb: (t: Transport) => void): void;
  /** Closes every guest transport (letting sent messages arrive first) and releases the code. */
  close(): void;
}

/** The real PeerJS constructor, imported lazily so the library loads only for online play. */
const createPeerJs: PeerFactory = async (id, options) => {
  const { Peer } = await import('peerjs');
  return id === null ? new Peer(options) : new Peer(id, options);
};

/** The overrides baked in by Vite at build time. */
function buildEnv(): PeerEnvVars {
  const env = import.meta.env;
  return {
    VITE_PEER_HOST: env.VITE_PEER_HOST,
    VITE_PEER_PORT: env.VITE_PEER_PORT,
    VITE_PEER_PATH: env.VITE_PEER_PATH,
    VITE_PEER_KEY: env.VITE_PEER_KEY,
    VITE_ICE_SERVERS: env.VITE_ICE_SERVERS,
  };
}

interface Deps { options: BrokerOptions; s: Scheduler; rand: () => number; createPeer: PeerFactory; signal: AbortSignal | undefined }

function deps(opts: PeerEnv): Deps {
  return {
    options: peerOptions(opts.env ?? buildEnv()),
    s: opts.scheduler ?? new RealScheduler(),
    rand: opts.rand ?? Math.random,
    createPeer: opts.createPeer ?? createPeerJs,
    signal: opts.signal,
  };
}

/** Message of the NetError('cancelled') that hostGame/joinGame reject with when their signal aborts. */
const CANCELLED = 'cancelled by the caller';

/** Loads and constructs a Peer, turning a failure into a broker error. */
async function loadPeer(d: Deps, id: string | null): Promise<PeerLike> {
  try {
    return await d.createPeer(id, d.options);
  } catch (err) {
    throw new NetError('broker', err instanceof Error ? err.message : String(err));
  }
}

/** A new Peer (see loadPeer); rejects with 'cancelled' as soon as `d.signal` aborts, and a Peer created after that is destroyed. */
function newPeer(d: Deps, id: string | null): Promise<PeerLike> {
  const { signal } = d;
  if (signal?.aborted) return Promise.reject(new NetError('cancelled', CANCELLED));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new NetError('cancelled', CANCELLED));
    signal?.addEventListener('abort', abort);
    loadPeer(d, id).then((peer) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        peer.destroy();
        abort();
      } else resolve(peer);
    }, (err: unknown) => {
      signal?.removeEventListener('abort', abort);
      reject(err);
    });
  });
}

/** A PeerJS transport that can also be closed without waiting for sent messages to go out. */
interface ConnTransport extends Transport {
  /** Closes the connection at once (and runs `onEnd`); for a transport nothing has been sent on. */
  closeNow(): void;
}

/**
 * Wraps an open raw DataConnection. Messages go out as JSON strings (encodeMsg) and incoming data
 * goes through decodeMsg; a remote close or connection error is reported once via onClose; close()
 * closes the connection after CLOSE_FLUSH_MS and closeNow() at once. PeerJS's `close({ flush: true })`
 * is not used: in raw mode its close marker reaches the other side as the string "[object Object]"
 * and closes nothing. `onEnd` runs once when the connection is finished either way.
 */
function connTransport(conn: ConnLike, s: Scheduler, onEnd: () => void): ConnTransport {
  let open = true;
  const listeners = new TransportListeners();
  const end = (): void => {
    conn.close();
    onEnd();
  };
  /** Marks the transport closed by this side; false if it was already closed. */
  const closeLocally = (): boolean => {
    if (!open) return false;
    open = false;
    listeners.dropHeld();
    return true;
  };
  const lost = (reason: string): void => {
    if (!open) return;
    open = false;
    end();
    listeners.close(reason);
  };
  conn.on('data', (data) => {
    if (!open) return;
    const msg = decodeMsg(data);
    if (msg) listeners.message(msg);
  });
  conn.on('close', () => lost(REMOTE_CLOSED));
  conn.on('error', (err) => lost(err.type));
  return {
    send(msg) {
      if (!open) return;
      const json = encodeMsg(msg);
      if (json !== null) conn.send(json);
    },
    onMessage(cb) {
      listeners.onMessage(cb);
    },
    onClose(cb) {
      listeners.onClose(cb);
    },
    close() {
      if (closeLocally()) s.after(CLOSE_FLUSH_MS, end);
    },
    closeNow() {
      if (closeLocally()) end();
    },
    get bufferedAmount() {
      return conn.dataChannel?.bufferedAmount ?? 0;
    },
  };
}

/**
 * Resolves null once `peer` is registered with the broker, or the error that stopped it (type
 * 'timeout' after JOIN_TIMEOUT_MS, 'cancelled' when `signal` aborts).
 */
function brokerOpen(peer: PeerLike, s: Scheduler, signal: AbortSignal | undefined): Promise<PeerErrorLike | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: PeerErrorLike | null): void => {
      if (done) return;
      done = true;
      cancelTimeout();
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => finish({ type: 'cancelled', message: CANCELLED });
    const cancelTimeout = s.after(JOIN_TIMEOUT_MS, () => finish({ type: 'timeout', message: `no answer from the broker in ${JOIN_TIMEOUT_MS} ms` }));
    signal?.addEventListener('abort', abort);
    if (signal?.aborted) abort();
    peer.on('open', () => finish(null));
    peer.on('error', (err) => finish(err));
  });
}

class PeerHost implements HostHandle {
  private guestCb: ((t: Transport) => void) | null = null;
  private readonly unclaimed: Transport[] = [];
  private readonly guests = new Set<Transport>();
  private closed = false;
  private cancelReconnect: (() => void) | null = null;

  constructor(readonly code: string, private readonly peer: PeerLike, private readonly s: Scheduler) {
    peer.on('connection', (conn) => conn.on('open', () => this.admit(conn)));
    peer.on('disconnected', () => this.reconnectLater());
  }

  onGuest(cb: (t: Transport) => void): void {
    this.guestCb = cb;
    for (const t of this.unclaimed.splice(0)) cb(t);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unclaimed.length = 0;
    this.cancelReconnect?.();
    if (this.guests.size === 0) {
      this.peer.destroy();
      return;
    }
    for (const t of this.guests) t.close();
    this.s.after(CLOSE_FLUSH_MS, () => this.peer.destroy());
  }

  private admit(conn: ConnLike): void {
    if (this.closed) {
      conn.close();
      return;
    }
    const t = connTransport(conn, this.s, () => {
      this.guests.delete(t);
      const i = this.unclaimed.indexOf(t);
      if (i >= 0) this.unclaimed.splice(i, 1);
      this.reconnectLater();
    });
    this.guests.add(t);
    if (this.guestCb) this.guestCb(t);
    else this.unclaimed.push(t);
  }

  /** Re-registers the code with the broker, but only while no guest is connected (spec §5.3: lobby yes, match no). */
  private reconnectLater(): void {
    if (this.closed || this.cancelReconnect || this.guests.size > 0 || !this.peer.disconnected) return;
    this.cancelReconnect = this.s.after(RECONNECT_DELAY_MS, () => {
      this.cancelReconnect = null;
      if (!this.closed && this.guests.size === 0 && this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
    });
  }
}

/**
 * Registers a new game code with the broker (PeerJS id `bbtennis-<CODE>`), silently picking a new
 * code when one is taken (HOST_CODE_TRIES codes at most). Rejects with a NetError, 'cancelled' when
 * `opts.signal` aborts.
 */
export async function hostGame(opts: PeerEnv = {}): Promise<HostHandle> {
  const d = deps(opts);
  for (let attempt = 1; ; attempt++) {
    const code = genCode(d.rand);
    const peer = await newPeer(d, PEER_ID_PREFIX + code);
    const failure = await brokerOpen(peer, d.s, d.signal);
    if (d.signal?.aborted) {
      peer.destroy();
      throw new NetError('cancelled', CANCELLED);
    }
    if (failure === null) return new PeerHost(code, peer, d.s);
    peer.destroy();
    if (failure.type !== 'unavailable-id' || attempt >= HOST_CODE_TRIES) throw new NetError(errorKind(failure.type), failure.message);
  }
}

/**
 * Connects to the host of `code` with a reliable raw DataConnection, resolving once it is open.
 * Fails after JOIN_TIMEOUT_MS with 'nat' if the broker was reached, else 'broker'; a malformed code
 * fails with 'notFound', and an aborted `opts.signal` with 'cancelled'. Reports STILL_CONNECTING
 * through `opts.onStatus` after SLOW_STATUS_MS.
 */
export async function joinGame(code: string, opts: PeerEnv = {}): Promise<Transport> {
  const normalized = normalizeCode(code);
  if (normalized === null) throw new NetError('notFound', `malformed code ${JSON.stringify(code)}`);
  const d = deps(opts);
  const peer = await newPeer(d, null);
  const transport = await new Promise<ConnTransport>((resolve, reject) => {
    let brokerReached = false;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      cancelSlow();
      cancelTimeout();
      d.signal?.removeEventListener('abort', abort);
      return true;
    };
    const fail = (kind: NetErrorKind, message: string): void => {
      if (!settle()) return;
      peer.destroy();
      reject(new NetError(kind, message));
    };
    const abort = (): void => fail('cancelled', CANCELLED);
    const cancelSlow = d.s.after(SLOW_STATUS_MS, () => opts.onStatus?.(STILL_CONNECTING));
    const cancelTimeout = d.s.after(JOIN_TIMEOUT_MS, () => {
      fail(brokerReached ? 'nat' : 'broker', `not connected after ${JOIN_TIMEOUT_MS} ms`);
    });
    d.signal?.addEventListener('abort', abort);
    if (d.signal?.aborted) abort();
    peer.on('error', (err) => fail(errorKind(err.type), err.message));
    peer.on('open', () => {
      brokerReached = true;
      const conn = peer.connect(PEER_ID_PREFIX + normalized, { reliable: true, serialization: 'raw' });
      conn.on('open', () => {
        if (settle()) resolve(connTransport(conn, d.s, () => peer.destroy()));
        else conn.close();
      });
      conn.on('error', (err) => fail(errorKind(err.type), err.message));
      conn.on('close', () => fail('nat', 'connection closed before it opened'));
    });
  });
  if (d.signal?.aborted) {
    transport.closeNow();
    throw new NetError('cancelled', CANCELLED);
  }
  return transport;
}
