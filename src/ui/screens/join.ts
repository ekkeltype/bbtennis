import type { MatchConfig, Profile } from '../../core/types';
import { GuestSession } from '../../game/guestSession';
import { LobbyLink, type Departure } from '../../game/onlineLink';
import { ALPHABET, normalizeCode } from '../../net/codes';
import { errorText, NetError } from '../../net/peer';
import { APP_ID, PROTO, type NetMsg } from '../../net/protocol';
import type { Transport } from '../../net/transport';
import { button, panel, type Choice } from '../controls';
import { h } from '../dom';
import { humanPlayer } from '../players';
import type { ScreenFactory } from '../router';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, PACK_CHOICES, SURFACE_CHOICES } from '../options';
import { keepFocus, OpponentCard, PING_REFRESH_MS, pingText, readyButton, readyStatus, showReady } from './lobby';
import type { JoinParams, OnlineContext, OnlineEnv } from './online';

/** How long the guest waits for the host's answer to its hello. */
const HANDSHAKE_MS = 10000;

type StartMsg = Extract<NetMsg, { type: 'start' }>;

/** What the join screen is doing: waiting for a code, connecting (and saying hello), in the lobby, failed, or handed to the match. */
export type JoinPhase = 'idle' | 'connecting' | 'joined' | 'failed' | 'started';

/** How to set up the guest side of a lobby. */
export interface GuestLobbyOptions {
  env: OnlineEnv;
  /** The guest's name and look. */
  me: Profile;
  /** Something shown has changed. */
  onChange(): void;
  /** The host started the match: its session. */
  onStart(session: GuestSession): void;
}

/**
 * The guest side of the lobby (spec §4.6, §5.3): connects to a game code, says `hello`, and on
 * `welcome` shows the host and the match config (read-only, following the host's `lobby` updates)
 * with both Ready flags; the guest's Ready toggle sends `ready{on}`. The host's `start` hands the
 * transport, that message first, to a new GuestSession; the lobby hears nothing more. A failed
 * connection, a `reject`, no answer within 10 s, or a host who leaves ends in 'failed' with a message.
 */
export class GuestLobby {
  phase: JoinPhase = 'idle';
  /** Progress while connecting: "Connecting…", then the connection's own status. */
  status = '';
  /** What went wrong ('failed'). */
  error: string | null = null;
  /** The host's name and look once welcomed. */
  host: Profile | null = null;
  /** The host's match config once welcomed. */
  config: MatchConfig | null = null;
  /** Ready flags: [host, guest]. */
  ready: [boolean, boolean] = [false, false];
  private abort: AbortController | null = null;
  private link: LobbyLink | null = null;
  private stopTimer: () => void = () => {};

  constructor(private readonly o: GuestLobbyOptions) {}

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
    this.o.env.joinGame(code, { signal: abort.signal, onStatus }).then(
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
    this.link?.send({ type: 'ready', on: this.ready[1] });
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
  private greet(t: Transport): void {
    const s = this.o.env.scheduler;
    const link = new LobbyLink(t, s, { message: (m) => this.onMessage(m), gone: (why) => this.onGone(why) });
    this.link = link;
    link.open();
    const me = this.o.me;
    link.send({ type: 'hello', proto: PROTO, app: APP_ID, name: me.name, look: me.look });
    this.stopTimer = s.after(HANDSHAKE_MS, () => {
      if (this.phase === 'connecting') this.fail(errorText(new NetError('timeout')));
    });
  }

  private onMessage(m: NetMsg): void {
    switch (m.type) {
      case 'welcome':
        if (this.phase !== 'connecting') return;
        if (m.proto !== PROTO) {
          this.fail(errorText(new NetError('version', 'welcome from another version', { host: m.proto, you: PROTO })));
          return;
        }
        this.stopTimer();
        this.phase = 'joined';
        this.host = m.hostProfile;
        this.config = m.config;
        this.ready = [false, false];
        this.o.onChange();
        return;
      case 'reject':
        if (this.phase !== 'connecting') return;
        this.fail(errorText(m.reason === 'version' ? new NetError('version', 'rejected', { host: m.proto, you: PROTO }) : new NetError('full')));
        return;
      case 'lobby':
        if (this.phase !== 'joined') return;
        this.config = m.config;
        this.ready = m.ready;
        this.o.onChange();
        return;
      case 'start':
        if (this.phase === 'joined') this.start(m);
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
  private start(m: StartMsg): void {
    const link = this.link;
    if (link === null) return;
    this.phase = 'started';
    const e = this.o.env;
    this.o.onStart(new GuestSession({ transport: link.handOver([m]), scheduler: e.scheduler, me: humanPlayer(this.o.me), ticker: e.ticker }));
  }
}

/** The name of `v` among `choices`. */
function choiceLabel<T>(choices: readonly Choice<T>[], v: T): string {
  return choices.find((c) => c.value === v)?.label ?? '';
}

/** The labels of the match config's rows, as the host lobby names them. */
const CONFIG_LABELS = ['FORMAT', 'PACE', 'COURT', 'WORDS', 'DEUCE'] as const;

/** The names of the match config's choices, in CONFIG_LABELS order (the guest sees them read-only, spec §4.6). */
function configValues(c: MatchConfig): string[] {
  return [
    choiceLabel(FORMAT_CHOICES, c.format),
    choiceLabel(PACE_CHOICES, c.pace),
    choiceLabel(SURFACE_CHOICES, c.surface),
    choiceLabel(PACK_CHOICES, c.wordPack),
    choiceLabel(DEUCE_CHOICES, c.deuceRule),
  ];
}

/** The characters of `s` that no game code uses, each once. */
function outsideAlphabet(s: string): string[] {
  return [...new Set([...s].filter((ch) => !ALPHABET.includes(ch)))];
}

/** Removes `?join=` from the page's URL once joined (spec §4.6), keeping the rest of it. */
function dropJoinParam(): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('join')) return;
    url.searchParams.delete('join');
    history.replaceState(history.state, '', url);
  } catch {
    // A sandboxed page may not rewrite its URL; the parameter then stays.
  }
}

/**
 * Join screen (spec §4.6, §5.4): the code field (trimmed and uppercased as typed; characters outside
 * the code alphabet get a hint) and Connect, with "Connecting…" / "Still connecting…"; once in the
 * lobby, the host (name, look, Ready), the match config read-only and the guest's Ready toggle.
 * `?join=CODE` fills the code in with Connect focused; joining removes the parameter from the URL.
 * Errors offer Retry and Back.
 */
export function joinScreen(ctx: OnlineContext): ScreenFactory {
  return (params) => {
    const { deps, env } = ctx;
    const invite = (params as JoinParams | undefined)?.code ?? null;
    const lobby = new GuestLobby({
      env,
      me: deps.profile(),
      onChange: () => show(),
      onStart: (session) => ctx.begin(session, () => {}),
    });

    const field = h('input', { class: 'code-field', type: 'text', maxlength: 16, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Game code' });
    const hint = h('p', { class: 'hint', hidden: true });
    const code = (): string | null => normalizeCode(field.value);
    const connect = (): void => {
      const c = code();
      if (c !== null) lobby.connect(c);
    };
    const tidy = (): void => {
      const v = field.value.toUpperCase().trim();
      if (v !== field.value) field.value = v;
      const bad = outsideAlphabet(v);
      hint.hidden = bad.length === 0;
      hint.textContent = `${bad.join(' ')}: not in codes (A-Z and 2-9, no O I L 0 1)`;
      show();
    };
    field.addEventListener('input', tidy);
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      connect();
    });
    const entry = h('div', { class: 'code-entry' }, h('label', { class: 'row name-row' }, h('span', { class: 'label' }, 'CODE'), field), hint);

    const card = new OpponentCard();
    const values = CONFIG_LABELS.map(() => h('span', { class: 'value' }));
    const config = h(
      'div',
      { class: 'rows config' },
      ...CONFIG_LABELS.map((label, i) => h('div', { class: 'row info' }, h('span', { class: 'label' }, label), values[i])),
    );
    const lobbyView = h('div', { class: 'split', hidden: true }, card.el, config);
    const status = h('p', { class: 'message status' });
    const ping = h('p', { class: 'ping' });
    const connectBtn = button('CONNECT', connect, 'primary');
    const ready = readyButton(() => lobby.toggleReady());
    const retry = button('RETRY', connect, 'primary');
    const back = button('BACK', () => ctx.router.back());
    const el = h(
      'div',
      { class: 'screen dim' },
      panel('JOIN GAME', 'lobby join', entry, lobbyView, h('div', { class: 'foot' }, status, ping), h('div', { class: 'actions' }, connectBtn, ready, retry, back)),
    );

    let shownPhase: JoinPhase | null = null;
    function show(): void {
      const p = lobby.phase;
      const inLobby = p === 'joined' || p === 'started';
      entry.hidden = inLobby;
      field.disabled = p === 'connecting';
      lobbyView.hidden = !inLobby;
      connectBtn.hidden = p !== 'idle';
      connectBtn.disabled = code() === null;
      retry.hidden = p !== 'failed';
      retry.disabled = code() === null;
      ready.hidden = !inLobby;
      card.show(lobby.host, lobby.ready[0]);
      showReady(ready, lobby.ready[1], p === 'joined');
      if (lobby.config !== null) configValues(lobby.config).forEach((v, i) => (values[i]!.textContent = v));
      status.textContent = joinStatus(lobby);
      if (inLobby) dropJoinParam();
      keepFocus(el, [ready, connectBtn, retry, field, back], p === shownPhase ? [] : [back]);
      shownPhase = p;
    }

    if (invite !== null) field.value = invite;
    let stopPing = (): void => {};
    return {
      el,
      onShow: () => {
        // Focuses Connect for a valid invite code, else the field.
        tidy();
        card.start();
        stopPing = env.scheduler.every(PING_REFRESH_MS, () => {
          ping.textContent = pingText(lobby.rttMs);
        });
      },
      onHide: () => {
        stopPing();
        card.stop();
        lobby.cancel();
      },
    };
  };
}

/** The join screen's status line. */
function joinStatus(lobby: GuestLobby): string {
  switch (lobby.phase) {
    case 'idle':
      return '';
    case 'connecting':
      return lobby.status;
    case 'failed':
      return lobby.error ?? '';
    case 'joined':
    case 'started':
      return readyStatus(lobby.host?.name ?? '', lobby.ready, 1);
  }
}
