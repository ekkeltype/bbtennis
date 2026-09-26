import { RealScheduler, type Scheduler } from '../game/clock';
import { genCode, normalizeCode } from './codes';
import { MAX_SEND_BYTES, msgBytes, parseMsg, type NetMsg } from './protocol';
import { REMOTE_CLOSED, type Transport } from './transport';

/** Prefix of every host's PeerJS id; the rest is the game code. */
export const PEER_ID_PREFIX = 'bbtennis-';

/** ICE servers used unless VITE_ICE_SERVERS overrides them (spec §5.3). */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

/** Codes a host tries when the broker says the id is taken (spec §5.3). */
export const HOST_CODE_TRIES = 5;

/** Time allowed to reach the broker (host) or open the connection (guest) (spec §5.4). */
export const JOIN_TIMEOUT_MS = 20000;

/** Delay before a join reports STILL_CONNECTING (spec §5.4). */
export const SLOW_STATUS_MS = 5000;

/** A closing transport waits this long for its flush before force-closing (spec §5.3). */
export const CLOSE_FLUSH_MS = 500;

/** Delay before a host that lost the broker re-registers its code. */
export const RECONNECT_DELAY_MS = 2000;

/** Status reported by joinGame after SLOW_STATUS_MS. */
export const STILL_CONNECTING = 'Still connecting…';

/** Build-time broker and ICE overrides (spec §5.3); values are strings as Vite provides them. */
export interface PeerEnvVars {
  VITE_PEER_HOST?: string;
  VITE_PEER_PORT?: string;
  VITE_PEER_PATH?: string;
  VITE_PEER_KEY?: string;
  VITE_ICE_SERVERS?: string;
}

/** Options for the PeerJS Peer constructor; absent fields keep the PeerJS cloud defaults. */
export interface BrokerOptions {
  host?: string;
  port?: number;
  path?: string;
  key?: string;
  config: { iceServers: RTCIceServer[] };
}

/** A PeerJS error: `type` is a PeerErrorType or connection error type string. */
export interface PeerErrorLike { type: string; message: string }

/** The part of a PeerJS DataConnection used here. */
export interface ConnLike {
  on(event: 'open', fn: () => void): unknown;
  on(event: 'data', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: PeerErrorLike) => void): unknown;
  send(data: unknown): unknown;
  close(options?: { flush?: boolean }): void;
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
}

/** User-facing network failure classes (spec §5.4). */
export type NetErrorKind = 'notFound' | 'broker' | 'webrtc' | 'nat' | 'version' | 'full' | 'timeout';

/** A network failure; show it with errorText. `versions` are protocol versions for kind 'version'. */
export class NetError extends Error {
  override readonly name = 'NetError';

  constructor(readonly kind: NetErrorKind, message: string = kind, readonly versions?: { host: number; you: number }) {
    super(message);
  }
}

/** A registered host waiting for guests. */
export interface HostHandle {
  /** The 5-character game code guests type. */
  code: string;
  /** Sets the listener for guests whose connection is open; guests that arrived earlier are handed over at once. */
  onGuest(cb: (t: Transport) => void): void;
  /** Closes every guest transport (with flush) and releases the code. */
  close(): void;
}

const warnEnv = (name: string, value: string, fallback: string): void => {
  console.warn(`[bbt] ignoring ${name}=${JSON.stringify(value)}; ${fallback}`);
};

const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((u) => typeof u === 'string');

function isIceServer(v: unknown): v is RTCIceServer {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const optionalString = (x: unknown): boolean => x === undefined || typeof x === 'string';
  return (typeof s.urls === 'string' || isStringList(s.urls)) && optionalString(s.username) && optionalString(s.credential);
}

function parseIceServers(json: string): RTCIceServer[] | null {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every(isIceServer) ? v : null;
  } catch {
    return null;
  }
}

/** Broker options from VITE_PEER_* / VITE_ICE_SERVERS; blank values are unset, invalid ones are ignored with a warning. */
export function peerOptions(env: PeerEnvVars): BrokerOptions {
  const value = (v: string | undefined): string | null => (v !== undefined && v.trim() !== '' ? v.trim() : null);
  const options: BrokerOptions = { config: { iceServers: DEFAULT_ICE_SERVERS } };
  const host = value(env.VITE_PEER_HOST);
  if (host !== null) options.host = host;
  const port = value(env.VITE_PEER_PORT);
  if (port !== null) {
    const n = Number(port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) options.port = n;
    else warnEnv('VITE_PEER_PORT', port, 'using the default port');
  }
  const path = value(env.VITE_PEER_PATH);
  if (path !== null) options.path = path;
  const key = value(env.VITE_PEER_KEY);
  if (key !== null) options.key = key;
  const ice = value(env.VITE_ICE_SERVERS);
  if (ice !== null) {
    const servers = parseIceServers(ice);
    if (servers) options.config = { iceServers: servers };
    else warnEnv('VITE_ICE_SERVERS', ice, 'expected a JSON array of RTCIceServer; using the default ICE servers');
  }
  return options;
}

const ERROR_KINDS: Record<string, NetErrorKind> = {
  'peer-unavailable': 'notFound',
  'browser-incompatible': 'webrtc',
  webrtc: 'webrtc',
  'negotiation-failed': 'nat',
  'connection-closed': 'nat',
};

/** Maps a PeerJS error type to a NetErrorKind (spec §5.4); anything unlisted is a broker problem. */
export function errorKind(type: string): NetErrorKind {
  return Object.hasOwn(ERROR_KINDS, type) ? ERROR_KINDS[type]! : 'broker';
}

/** The message shown for `e` (spec §5.4); `code` is the game code the user tried. */
export function errorText(e: NetError, code?: string): string {
  switch (e.kind) {
    case 'notFound':
      return code ? `No game with code ${code}` : 'No game with that code';
    case 'broker':
      return "Can't reach the connection server";
    case 'webrtc':
      return 'Your browser has WebRTC disabled';
    case 'nat':
      return "Couldn't connect directly (firewall/NAT) — try another network";
    case 'version':
      return e.versions
        ? `Versions differ (host v${e.versions.host}, you v${e.versions.you}) — reload with Ctrl+Shift+R`
        : 'Versions differ — reload with Ctrl+Shift+R';
    case 'full':
      return 'That game already has two players';
    case 'timeout':
      return "The game didn't answer — try again";
  }
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

interface Deps { options: BrokerOptions; s: Scheduler; rand: () => number; createPeer: PeerFactory }

function deps(opts: PeerEnv): Deps {
  return {
    options: peerOptions(opts.env ?? buildEnv()),
    s: opts.scheduler ?? new RealScheduler(),
    rand: opts.rand ?? Math.random,
    createPeer: opts.createPeer ?? createPeerJs,
  };
}

/** Creates a Peer, turning a failure to load or construct PeerJS into a broker error. */
async function newPeer(d: Deps, id: string | null): Promise<PeerLike> {
  try {
    return await d.createPeer(id, d.options);
  } catch (err) {
    throw new NetError('broker', err instanceof Error ? err.message : String(err));
  }
}

/** PeerJS's DataConnection error for a send over its JSON channel limit; the connection itself is fine. */
const MESSAGE_TOO_BIG = 'message-too-big';

/**
 * Wraps an open DataConnection. Incoming data goes through parseMsg; a remote close or connection
 * error is reported once via onClose; close() flushes, then force-closes after CLOSE_FLUSH_MS.
 * A message over MAX_SEND_BYTES is dropped with a warning, and so is one PeerJS refuses as too big;
 * neither ends the connection. `onEnd` runs once when the connection is finished either way.
 */
function connTransport(conn: ConnLike, s: Scheduler, onEnd: () => void): Transport {
  let open = true;
  const messageCbs: ((m: NetMsg) => void)[] = [];
  const closeCbs: ((reason: string) => void)[] = [];
  const lost = (reason: string): void => {
    if (!open) return;
    open = false;
    conn.close();
    onEnd();
    for (const cb of closeCbs) cb(reason);
  };
  conn.on('data', (raw) => {
    if (!open) return;
    const msg = parseMsg(raw);
    if (msg) for (const cb of messageCbs) cb(msg);
  });
  conn.on('close', () => lost(REMOTE_CLOSED));
  conn.on('error', (err) => {
    if (err.type === MESSAGE_TOO_BIG) console.warn(`[bbt] PeerJS dropped a message: ${err.message}`);
    else lost(err.type);
  });
  return {
    send(msg) {
      const bytes = msgBytes(msg);
      if (bytes > MAX_SEND_BYTES) console.warn(`[bbt] dropped a ${msg.type} message of ${bytes} bytes (limit ${MAX_SEND_BYTES})`);
      else if (open) conn.send(msg);
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      if (!open) return;
      open = false;
      conn.close({ flush: true });
      s.after(CLOSE_FLUSH_MS, () => {
        conn.close();
        onEnd();
      });
    },
    get bufferedAmount() {
      return conn.dataChannel?.bufferedAmount ?? 0;
    },
  };
}

/** Resolves null once `peer` is registered with the broker, or the error that stopped it (type 'timeout' after JOIN_TIMEOUT_MS). */
function brokerOpen(peer: PeerLike, s: Scheduler): Promise<PeerErrorLike | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: PeerErrorLike | null): void => {
      if (done) return;
      done = true;
      cancel();
      resolve(result);
    };
    const cancel = s.after(JOIN_TIMEOUT_MS, () => finish({ type: 'timeout', message: `no answer from the broker in ${JOIN_TIMEOUT_MS} ms` }));
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
 * code when one is taken (HOST_CODE_TRIES codes at most). Rejects with a NetError.
 */
export async function hostGame(opts: PeerEnv = {}): Promise<HostHandle> {
  const d = deps(opts);
  for (let attempt = 1; ; attempt++) {
    const code = genCode(d.rand);
    const peer = await newPeer(d, PEER_ID_PREFIX + code);
    const failure = await brokerOpen(peer, d.s);
    if (failure === null) return new PeerHost(code, peer, d.s);
    peer.destroy();
    if (failure.type !== 'unavailable-id' || attempt >= HOST_CODE_TRIES) throw new NetError(errorKind(failure.type), failure.message);
  }
}

/**
 * Connects to the host of `code` with a reliable JSON DataConnection, resolving once it is open.
 * Fails after JOIN_TIMEOUT_MS with 'nat' if the broker was reached, else 'broker'; a malformed code
 * fails with 'notFound'. Reports STILL_CONNECTING through `opts.onStatus` after SLOW_STATUS_MS.
 */
export async function joinGame(code: string, opts: PeerEnv = {}): Promise<Transport> {
  const normalized = normalizeCode(code);
  if (normalized === null) throw new NetError('notFound', `malformed code ${JSON.stringify(code)}`);
  const d = deps(opts);
  const peer = await newPeer(d, null);
  return new Promise<Transport>((resolve, reject) => {
    let brokerReached = false;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      cancelSlow();
      cancelTimeout();
      return true;
    };
    const fail = (kind: NetErrorKind, message: string): void => {
      if (!settle()) return;
      peer.destroy();
      reject(new NetError(kind, message));
    };
    const cancelSlow = d.s.after(SLOW_STATUS_MS, () => opts.onStatus?.(STILL_CONNECTING));
    const cancelTimeout = d.s.after(JOIN_TIMEOUT_MS, () => {
      fail(brokerReached ? 'nat' : 'broker', `not connected after ${JOIN_TIMEOUT_MS} ms`);
    });
    peer.on('error', (err) => fail(errorKind(err.type), err.message));
    peer.on('open', () => {
      brokerReached = true;
      const conn = peer.connect(PEER_ID_PREFIX + normalized, { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        if (settle()) resolve(connTransport(conn, d.s, () => peer.destroy()));
      });
      conn.on('error', (err) => fail(errorKind(err.type), err.message));
      conn.on('close', () => fail('nat', 'connection closed before it opened'));
    });
  });
}
