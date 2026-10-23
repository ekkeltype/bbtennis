import type { Look, Profile } from '../core/types';
import type { Scheduler } from '../game/clock';
import type { Transport } from './channel';
import { LobbyLink, type Departure } from './link';
import { errorText, NetError } from './netErrors';
import type { HostHandle, PeerEnv } from './rtc';

/** A connected guest that has not said hello this long is closed (the join screen waits as long for its answer). */
const HELLO_DEADLINE_MS = 10_000;
/** How long the guest waits for the host's answer to its hello. */
const HANDSHAKE_MS = 10000;

/** What a guest's hello must match (spec §5.3): the protocol version and the app id. */
export interface LobbyProto { proto: number; app: string }

/** The lobby's messages (spec §5.3) for a match config `C`; every protocol a lobby carries includes them (and LinkMsg). */
export type LobbyMsg<C> =
  | { type: 'hello'; proto: number; app: string; name: string; look: Look }
  | { type: 'welcome'; proto: number; hostProfile: Profile; config: C }
  | { type: 'reject'; reason: 'version' | 'full' | 'in-match'; proto: number; app: string }
  | { type: 'lobby'; config: C; ready: [boolean, boolean] }
  | { type: 'ready'; on: boolean };

type HelloMsg = Extract<LobbyMsg<unknown>, { type: 'hello' }>;

/** The `type` of every LobbyMsg. */
const LOBBY_TYPES: ReadonlySet<string> = new Set(['hello', 'welcome', 'reject', 'lobby', 'ready']);

/**
 * The one place the lobby's messages meet a protocol's messages `M`. `M`'s union includes LobbyMsg<C>
 * (a lobby requires it), which TypeScript cannot check for type parameters: `asMsg` casts a lobby
 * message on its way out, and `asLobby` reads a received message as one when its type is a lobby
 * message's (null for every other message).
 */
const asMsg = <M, C>(m: LobbyMsg<C>): M => m as unknown as M;
const asLobby = <C>(m: { type: string }): LobbyMsg<C> | null => (LOBBY_TYPES.has(m.type) ? (m as LobbyMsg<C>) : null);

/**
 * A version mismatch (spec §5.4) between the host's protocol and this side's: with both versions when
 * the numbers differ; without them when they are equal (another app id, such as another build).
 */
function versionError(message: string, host: number, you: number): NetError {
  return new NetError('version', message, host !== you ? { host, you } : undefined);
}

// ---------------------------------------------------------------------------------------------
// The host side

/** What the host lobby is doing: getting a code, waiting for a guest, with a guest, failed, or handed to the match. */
export type HostPhase = 'opening' | 'waiting' | 'joined' | 'failed' | 'started';

/** What the host's match session starts from: the match config, both players and a fresh seed. */
export interface HostStart<C> { config: C; me: Profile; guest: Profile; seed: number }

/** How to set up a host lobby, for a match config `C`, protocol messages `M` and match sessions `S`. */
export interface HostLobbyOptions<C, M, S> {
  /** What a guest's hello must match; the host's welcome and reject carry it. */
  proto: LobbyProto;
  /** Registers a game code (spec §5.3). */
  host(opts: PeerEnv): Promise<HostHandle<M>>;
  /** Time and timers of the lobby (heartbeats, hello deadlines). */
  scheduler: Scheduler;
  /** A fresh seed for the match. */
  seed(): number;
  /** The host's name and look. */
  me: Profile;
  /** The match config it starts with. */
  config: C;
  /** Something shown has changed. */
  onChange(): void;
  /** Both are ready: the match session on the guest's transport (it sends the match's `start` itself). */
  session(t: Transport<M>, start: HostStart<C>): S;
  /** The match has started: its session, and what releases the game code once the match is done. */
  onStart(session: S, release: () => void): void;
}

/**
 * The host side of the lobby (spec §4.6, §5.3). It registers a game code and admits one guest:
 * `hello` → `welcome`, or `reject` with 'version' (another protocol or app id), 'in-match' (the match
 * has started) or 'full' (a guest is in), after which that connection closes. The host edits the
 * match config; each change clears both Ready flags, and every change of config or Ready reaches the
 * guest as `lobby{config, ready}`. Once both are ready the guest's transport goes to a new session
 * (the options' `session`), which sends `start` itself; the lobby hears nothing more from it. The code
 * stays registered during the match, turning later guests away, until `release`. A connection that
 * goes away before its hello, or says none within 10 s, is closed. `M`'s union must include
 * LobbyMsg<C> and LinkMsg.
 */
export class HostLobby<C, M extends { type: string }, S> {
  phase: HostPhase = 'opening';
  /** The game code, once registered. */
  code: string | null = null;
  /** Why registering failed ('failed'). */
  error: NetError | null = null;
  /** The admitted guest's name and look. */
  guest: Profile | null = null;
  config: C;
  /** Ready flags: [host, guest]. */
  ready: [boolean, boolean] = [false, false];
  private abort: AbortController | null = null;
  private handle: HostHandle<M> | null = null;
  /** The admitted guest's link. */
  private link: LobbyLink<M> | null = null;
  /** Guests that have not said hello yet, each with what cancels its hello deadline. */
  private readonly pending = new Map<LobbyLink<M>, () => void>();

  constructor(private readonly o: HostLobbyOptions<C, M, S>) {
    this.config = { ...o.config };
  }

  /** The guest's round trip, or null. */
  get rttMs(): number | null {
    return this.link?.rttMs ?? null;
  }

  /** Registers a game code: at first, and again after a failure. */
  open(): void {
    if (this.phase !== 'opening' && this.phase !== 'failed') return;
    this.phase = 'opening';
    this.error = null;
    const abort = new AbortController();
    this.abort = abort;
    this.o.host({ signal: abort.signal }).then(
      (handle) => {
        if (abort.signal.aborted) {
          handle.close();
          return;
        }
        this.handle = handle;
        this.code = handle.code;
        this.phase = 'waiting';
        handle.onGuest((t) => this.admit(t));
        this.o.onChange();
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        this.phase = 'failed';
        this.error = err instanceof NetError ? err : new NetError('broker', String(err));
        this.o.onChange();
      },
    );
    this.o.onChange();
  }

  /** Changes the match config: both Ready flags clear, and the guest is told. */
  setConfig(patch: Partial<C>): void {
    if (this.phase === 'started') return;
    this.config = { ...this.config, ...patch };
    this.ready = [false, false];
    this.sendLobby();
    this.o.onChange();
  }

  /** Toggles the host's Ready flag while a guest is in; the match starts when both are ready. */
  toggleReady(): void {
    if (this.phase !== 'joined') return;
    this.ready = [!this.ready[0], this.ready[1]];
    this.sendLobby();
    this.maybeStart();
    this.o.onChange();
  }

  /** Leaves the lobby (Back, or its screen hides), unless the match has started: registering stops, guests are told, the code is released. */
  cancel(): void {
    if (this.phase !== 'started') this.close();
  }

  private close(): void {
    this.abort?.abort();
    for (const l of [...this.pending.keys()]) this.dropPending(l);
    this.link?.close();
    this.link = null;
    this.handle?.close();
    this.handle = null;
  }

  /** A guest's connection is open: it has a lobby link, pending until its hello (due within 10 s) is answered. */
  private admit(t: Transport<M>): void {
    const scheduler = this.o.scheduler;
    const link: LobbyLink<M> = new LobbyLink(t, scheduler, {
      message: (m) => this.onMessage(link, m),
      gone: () => this.onGone(link),
    });
    this.pending.set(link, scheduler.after(HELLO_DEADLINE_MS, () => this.dropPending(link)));
    link.open();
  }

  /** Takes `link` off the pending guests, cancelling its hello deadline; false when it was not pending. */
  private takePending(link: LobbyLink<M>): boolean {
    const cancel = this.pending.get(link);
    if (cancel === undefined) return false;
    cancel();
    this.pending.delete(link);
    return true;
  }

  /** A pending guest is let go (no hello in time, gone, or the lobby closes): its link closes, which stops its heartbeat. */
  private dropPending(link: LobbyLink<M>): void {
    if (this.takePending(link)) link.close();
  }

  private onMessage(link: LobbyLink<M>, m: M): void {
    const l = asLobby<C>(m);
    if (l?.type === 'hello') {
      if (this.takePending(link)) this.hello(link, l);
      return;
    }
    if (link !== this.link || this.phase !== 'joined' || l?.type !== 'ready') return;
    this.ready = [this.ready[0], l.on];
    this.sendLobby();
    this.maybeStart();
    this.o.onChange();
  }

  /** Welcomes the guest, or rejects it (version, match on, lobby full) and closes its connection. */
  private hello(link: LobbyLink<M>, m: HelloMsg): void {
    const { proto, app } = this.o.proto;
    const reason = m.proto !== proto || m.app !== app ? 'version' : this.phase === 'started' ? 'in-match' : this.link !== null ? 'full' : null;
    if (reason !== null) {
      link.send(asMsg({ type: 'reject', reason, proto, app }));
      link.close();
      return;
    }
    this.link = link;
    this.guest = { name: m.name, look: m.look };
    this.ready = [false, false];
    this.phase = 'joined';
    link.send(asMsg({ type: 'welcome', proto, hostProfile: this.o.me, config: this.config }));
    this.o.onChange();
  }

  /** A guest went away: a pending one is closed; the admitted one frees the lobby for the next. */
  private onGone(link: LobbyLink<M>): void {
    this.dropPending(link);
    if (link !== this.link || this.phase !== 'joined') return;
    link.close();
    this.link = null;
    this.guest = null;
    this.ready = [false, false];
    this.phase = 'waiting';
    this.o.onChange();
  }

  private sendLobby(): void {
    if (this.phase === 'joined') this.link?.send(asMsg({ type: 'lobby', config: this.config, ready: this.ready }));
  }

  /** Both are ready: the guest's transport goes to the match session (seeded here). */
  private maybeStart(): void {
    const { link, guest } = this;
    if (this.phase !== 'joined' || !this.ready[0] || !this.ready[1] || link === null || guest === null) return;
    this.phase = 'started';
    const session = this.o.session(link.handOver(), { config: this.config, me: this.o.me, guest, seed: this.o.seed() });
    this.o.onStart(session, () => this.close());
  }
}

// ---------------------------------------------------------------------------------------------
// The guest side

/** What the join screen is doing: waiting for a code, connecting (and saying hello), in the lobby, failed, or handed to the match. */
export type JoinPhase = 'idle' | 'connecting' | 'joined' | 'failed' | 'started';

/** How to set up the guest side of a lobby, for protocol messages `M` and match sessions `S`. */
export interface GuestLobbyOptions<M, S> {
  /** What the guest's hello says: its protocol version and app id. */
  proto: LobbyProto;
  /** Connects to the host of a game code (spec §5.3). */
  join(code: string, opts: PeerEnv): Promise<Transport<M>>;
  /** Time and timers of the lobby (heartbeat, the handshake timeout). */
  scheduler: Scheduler;
  /** The guest's name and look. */
  me: Profile;
  /** Something shown has changed. */
  onChange(): void;
  /** The host started the match: the guest's match session on the transport, whose first message is the host's `start`. */
  session(t: Transport<M>): S;
  /** The host started the match: its session. */
  onStart(session: S): void;
}

/**
 * The guest side of the lobby (spec §4.6, §5.3): connects to a game code, says `hello`, and on
 * `welcome` shows the host and the match config (read-only, following the host's `lobby` updates)
 * with both Ready flags; the guest's Ready toggle sends `ready{on}`. The host's `start` hands the
 * transport, that message first, to a new session (the options' `session`); the lobby hears nothing
 * more. A failed connection, a `reject`, no answer within 10 s, or a host who leaves ends in 'failed'
 * with a message. `M`'s union must include LobbyMsg<C>, LinkMsg and a `start` message.
 */
export class GuestLobby<C, M extends { type: string }, S> {
  phase: JoinPhase = 'idle';
  /** Progress while connecting: "Connecting…", then the connection's own status. */
  status = '';
  /** What went wrong ('failed'). */
  error: string | null = null;
  /** The host's name and look once welcomed. */
  host: Profile | null = null;
  /** The host's match config once welcomed. */
  config: C | null = null;
  /** Ready flags: [host, guest]. */
  ready: [boolean, boolean] = [false, false];
  private abort: AbortController | null = null;
  private link: LobbyLink<M> | null = null;
  private stopTimer: () => void = () => {};

  constructor(private readonly o: GuestLobbyOptions<M, S>) {}

  /** The host's round trip, or null. */
  get rttMs(): number | null {
    return this.link?.rttMs ?? null;
  }

  /** Connects to the host of `code` (a valid code) and says hello; again after a failure. */
  connect(code: string): void {
    if (this.phase !== 'idle' && this.phase !== 'failed') return;
    this.phase = 'connecting';
    this.status = 'Connecting…';
    this.error = null;
    const abort = new AbortController();
    this.abort = abort;
    const onStatus = (text: string): void => {
      if (abort.signal.aborted || this.phase !== 'connecting') return;
      this.status = text;
      this.o.onChange();
    };
    this.o.join(code, { signal: abort.signal, onStatus }).then(
      (t) => {
        if (abort.signal.aborted) t.close();
        else this.greet(t);
      },
      (err: unknown) => {
        if (!abort.signal.aborted) this.fail(errorText(err instanceof NetError ? err : new NetError('broker', String(err)), code));
      },
    );
    this.o.onChange();
  }

  /** Toggles the guest's Ready flag; the host starts the match when both are ready. */
  toggleReady(): void {
    if (this.phase !== 'joined') return;
    this.ready = [this.ready[0], !this.ready[1]];
    this.link?.send(asMsg({ type: 'ready', on: this.ready[1] }));
    this.o.onChange();
  }

  /** Leaves (Back, or the screen hides) unless the match has started: the attempt stops, and the host is told. */
  cancel(): void {
    if (this.phase === 'started') return;
    this.close();
    this.phase = 'idle';
  }

  private close(): void {
    this.abort?.abort();
    this.stopTimer();
    this.link?.close();
    this.link = null;
  }

  /** The connection is open: hello, and the host has HANDSHAKE_MS to answer. */
  private greet(t: Transport<M>): void {
    const s = this.o.scheduler;
    const link = new LobbyLink(t, s, { message: (m) => this.onMessage(m), gone: (why) => this.onGone(why) });
    this.link = link;
    link.open();
    const { me, proto } = this.o;
    link.send(asMsg({ type: 'hello', proto: proto.proto, app: proto.app, name: me.name, look: me.look }));
    this.stopTimer = s.after(HANDSHAKE_MS, () => {
      if (this.phase === 'connecting') this.fail(errorText(new NetError('timeout')));
    });
  }

  private onMessage(m: M): void {
    if (m.type === 'start') {
      if (this.phase === 'joined') this.start(m);
      return;
    }
    const l = asLobby<C>(m);
    const you = this.o.proto.proto;
    switch (l?.type) {
      case 'welcome':
        if (this.phase !== 'connecting') return;
        if (l.proto !== you) {
          this.fail(errorText(versionError('welcome from another version', l.proto, you)));
          return;
        }
        this.stopTimer();
        this.phase = 'joined';
        this.host = l.hostProfile;
        this.config = l.config;
        this.ready = [false, false];
        this.o.onChange();
        return;
      case 'reject':
        if (this.phase !== 'connecting') return;
        this.fail(errorText(l.reason === 'version' ? versionError('rejected', l.proto, you) : new NetError('full')));
        return;
      case 'lobby':
        if (this.phase !== 'joined') return;
        this.config = l.config;
        this.ready = l.ready;
        this.o.onChange();
        return;
      default:
        return;
    }
  }

  private onGone(why: Departure): void {
    if (this.phase === 'connecting') this.fail(why === 'left' ? 'The host left the game' : errorText(new NetError('timeout')));
    else if (this.phase === 'joined') this.fail(why === 'left' ? `${this.host?.name ?? 'The host'} left the game` : 'Lost the connection to the host');
  }

  private fail(message: string): void {
    this.close();
    this.phase = 'failed';
    this.error = message;
    this.o.onChange();
  }

  /** The host started the match: the transport, `start` first, goes to the guest's session. */
  private start(m: M): void {
    const link = this.link;
    if (link === null) return;
    this.phase = 'started';
    this.o.onStart(this.o.session(link.handOver([m])));
  }
}
