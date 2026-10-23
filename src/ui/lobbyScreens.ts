import type { Profile } from '../core/types';
import type { Scheduler } from '../game/clock';
import type { Transport } from '../net/channel';
import { ALPHABET, normalizeCode } from '../net/codes';
import { GuestLobby, HostLobby, type HostPhase, type HostStart, type JoinPhase, type LobbyProto } from '../net/lobby';
import { errorText } from '../net/netErrors';
import type { HostHandle, PeerEnv } from '../net/rtc';
import { button, panel } from './controls';
import { focusables, h } from './dom';
import { icon } from './icons';
import { LookPreview } from './preview';
import type { Router, ScreenFactory } from './router';
import { DEFAULT_PROFILE } from './settings';

/** How often a lobby screen refreshes the round trip it shows. */
export const PING_REFRESH_MS = 500;

// ---------------------------------------------------------------------------------------------
// What a game gives the lobby screens

/** The network and page the lobby screens work with, for a protocol's messages `M`; the browser's in the app, a test's own in tests. */
export interface LobbyEnv<M> {
  /** Registers a game code (spec §5.3). */
  hostGame(opts: PeerEnv): Promise<HostHandle<M>>;
  /** Connects to the host of a game code (spec §5.3). */
  joinGame(code: string, opts: PeerEnv): Promise<Transport<M>>;
  /** Time and timers of the lobbies and the matches. */
  scheduler: Scheduler;
  /** A fresh seed for the host's match. */
  seed(): number;
  /** Where invite links point (`${publicUrl}?join=CODE`, from VITE_PUBLIC_URL); null or empty: there is no invite link. */
  publicUrl: string | null;
  /** True inside an iframe (itch.io), where the invite link is the browser (Pages) build's (spec §8). */
  framed: boolean;
}

/** A game's lobby (spec §4.6): its protocol, the match options as the host edits and the guest reads them, and its match sessions. */
export interface LobbyGame<C, M extends { type: string }, S> {
  /** What a guest's hello must match. */
  proto: LobbyProto;
  /** The host's option spinners: rows that show `get()` and change it through `set`. */
  optionRows(get: () => C, set: (patch: Partial<C>) => void): HTMLElement[];
  /** Read-only option labels, and their values for a config, for the guest. */
  optionLabels: readonly string[];
  /** The names of `c`'s option values, in optionLabels order. */
  optionValues(c: C): string[];
  /** The host's match session on the guest's transport, from the lobby's start data. */
  hostSession(t: Transport<M>, start: HostStart<C>): S;
  /** The guest's match session on the host's transport, whose first message is the host's `start`; `me` is the guest. */
  guestSession(t: Transport<M>, me: Profile): S;
}

/** What the host lobby and join screens get from the app. */
export interface LobbyContext<C, M, S> {
  router: Router;
  /** The local player's name and look. */
  profile(): Profile;
  /** The match config the host's lobby starts with. */
  config(): C;
  env: LobbyEnv<M>;
  /** Hands a started match to the app, guarded while it runs; `release` runs once the app has disposed of it. */
  begin(session: S, release: () => void): void;
}

/** Params of the Join screen: the code from a `?join=CODE` invite link, if any. */
export interface JoinParams { code: string | null }

// ---------------------------------------------------------------------------------------------
// Pieces the host lobby and the join screen share

/**
 * The opponent in a lobby (spec §4.6): their look, animated while the card and its screen show, their
 * name and whether they are ready. Names come from the other player, so they are only ever set as text.
 */
export class OpponentCard {
  readonly el: HTMLElement;
  private readonly name = h('span', { class: 'name' });
  private readonly state = h('span', { class: 'state' });
  private readonly preview = new LookPreview(DEFAULT_PROFILE.look);
  private shownLook = '';
  private onScreen = false;
  private animating = false;

  constructor() {
    const [, far] = this.preview.canvases;
    this.el = h('figure', { class: 'opponent', hidden: true }, far, h('figcaption', {}, this.name, this.state));
  }

  /** Shows `p` and whether they are ready; null hides the card. */
  show(p: Profile | null, ready: boolean): void {
    this.el.hidden = p === null;
    if (p !== null) {
      this.name.textContent = p.name.toUpperCase();
      this.state.textContent = ready ? 'READY' : 'NOT READY';
      this.state.classList.toggle('on', ready);
      const look = JSON.stringify(p.look);
      if (look !== this.shownLook) {
        this.shownLook = look;
        this.preview.setLook(p.look);
      }
    }
    this.animate();
  }

  /** The screen shows: the look animates while the card shows. */
  start(): void {
    this.onScreen = true;
    this.animate();
  }

  /** The screen hides: the animation stops. */
  stop(): void {
    this.onScreen = false;
    this.animate();
  }

  private animate(): void {
    const on = this.onScreen && !this.el.hidden;
    if (on === this.animating) return;
    this.animating = on;
    if (on) this.preview.start();
    else this.preview.stop();
  }
}

/** The Ready toggle: READY, with a tick (and aria-pressed) while this player is ready. */
export function readyButton(onClick: () => void): HTMLButtonElement {
  const b = button('READY', onClick, 'primary ready');
  showReady(b, false, false);
  return b;
}

/** Updates a Ready toggle: pressed while `on`, usable while `enabled`. */
export function showReady(b: HTMLButtonElement, on: boolean, enabled: boolean): void {
  if (b.getAttribute('aria-pressed') !== String(on)) {
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren('READY', ...(on ? [icon('tick')] : []));
  }
  b.disabled = !enabled;
}

/** The status line once both players are in: who is ready (`me` is this side's index). */
export function readyStatus(name: string, ready: readonly [boolean, boolean], me: 0 | 1): string {
  const mine = ready[me];
  const theirs = ready[me === 0 ? 1 : 0];
  if (mine && theirs) return 'Starting…';
  if (mine) return `Waiting for ${name}…`;
  if (theirs) return `${name} is ready`;
  return 'Press READY when you are set';
}

/** The round trip as a lobby shows it, or '' before the first pong. */
export function pingText(rttMs: number | null): string {
  return rttMs === null ? '' : `PING ${Math.round(rttMs)} MS`;
}

/**
 * Moves the keyboard focus to the first of `preferred` that is shown and enabled when it is not on a
 * usable control of `root` (hiding a focused button never strands the keyboard), or when it rests on
 * one of `from` (a screen passes its resting controls, such as Back, when its view changes, so the new
 * view's main action gets the focus).
 */
export function keepFocus(root: HTMLElement, preferred: readonly HTMLElement[], from: readonly HTMLElement[] = []): void {
  const stops = focusables(root);
  const active = document.activeElement as HTMLElement;
  if (stops.includes(active) && !from.includes(active)) return;
  const target = preferred.find((el) => stops.includes(el)) ?? stops[0];
  target?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Clipboard (spec §8)

/** Copies `text` from a hidden textarea with execCommand('copy'); false when the browser refuses. */
function execCopy(text: string): boolean {
  const before = document.activeElement;
  const area = h('textarea', { readonly: true, 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
  area.value = text;
  document.body.append(area);
  area.focus({ preventScroll: true });
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (before instanceof HTMLElement) before.focus({ preventScroll: true });
  return ok;
}

/**
 * Copies `text` to the clipboard (spec §8). Without the Clipboard API: from a hidden textarea with
 * execCommand('copy'), inside the click. In a framed page (itch.io), which may allow execCommand only
 * synchronously inside the click, that goes first and the API follows if it refuses. Elsewhere the API
 * goes first, and execCommand follows if it refuses. Resolves false when nothing worked (the caller
 * then selects the text for Ctrl+C).
 */
function copyText(text: string, framed: boolean): Promise<boolean> {
  const api = navigator.clipboard as Clipboard | undefined;
  if (typeof api?.writeText !== 'function') return Promise.resolve(execCopy(text));
  if (framed && execCopy(text)) return Promise.resolve(true);
  return api.writeText(text).then(
    () => true,
    () => !framed && execCopy(text),
  );
}

/** Selects `el`'s text, for the player to copy with Ctrl+C. */
function selectText(el: HTMLElement): void {
  const sel = window.getSelection();
  if (sel === null) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---------------------------------------------------------------------------------------------
// The host lobby

/**
 * Host lobby screen (spec §4.6, §8): the game code at 2× with Copy code and Copy invite link
 * (`${publicUrl}?join=CODE`, hidden when unset, "Copy browser invite link" inside an iframe), the
 * guest once one joins (name, look, Ready), the match options the host edits (the game's rows,
 * starting from `ctx.config()`), both Ready flags and the round trip. Registering errors offer Retry
 * and Back; Back leaves the lobby.
 */
export function hostLobbyScreen<C, M extends { type: string }, S>(ctx: LobbyContext<C, M, S>, game: LobbyGame<C, M, S>): ScreenFactory {
  return () => {
    const { env } = ctx;
    const lobby = new HostLobby<C, M, S>({
      proto: game.proto,
      host: (opts) => env.hostGame(opts),
      scheduler: env.scheduler,
      seed: () => env.seed(),
      me: ctx.profile(),
      config: ctx.config(),
      onChange: () => show(),
      session: (t, start) => game.hostSession(t, start),
      onStart: (session, release) => ctx.begin(session, release),
    });

    const code = h('span', { class: 'code big selectable' });
    const link = h('span', { class: 'invite-url selectable', hidden: true });
    const note = h('p', { class: 'copy-note' });
    const copy = (text: string, el: HTMLElement, done: string): void => {
      void copyText(text, env.framed).then((ok) => {
        link.hidden = ok || el !== link;
        if (ok) {
          note.textContent = done;
          return;
        }
        selectText(el);
        note.textContent = 'Press Ctrl+C to copy';
      });
    };
    const copyCode = button('COPY CODE', () => copy(lobby.code ?? '', code, 'Code copied'));
    const inviteUrl = (): string => `${env.publicUrl}?join=${lobby.code ?? ''}`;
    const invite =
      env.publicUrl === null || env.publicUrl === ''
        ? null
        : button(env.framed ? 'COPY BROWSER INVITE LINK' : 'COPY INVITE LINK', () => {
            link.textContent = inviteUrl();
            copy(inviteUrl(), link, 'Invite link copied');
          });
    const codeBox = h('div', { class: 'code-box' }, h('span', { class: 'label' }, 'CODE'), code, h('div', { class: 'copy' }, copyCode, invite));

    const card = new OpponentCard();
    const rows = h('div', { class: 'rows' }, ...game.optionRows(() => lobby.config, (patch) => lobby.setConfig(patch)));
    const body = h('div', { class: 'body' }, codeBox, h('div', { class: 'copied' }, note, link), h('div', { class: 'split' }, card.el, rows));
    const status = h('p', { class: 'message status' });
    const ping = h('p', { class: 'ping' });
    const ready = readyButton(() => lobby.toggleReady());
    const retry = button('RETRY', () => lobby.open(), 'primary');
    const back = button('BACK', () => ctx.router.back());
    const el = h(
      'div',
      { class: 'screen dim' },
      panel('HOST GAME', 'lobby host', body, h('div', { class: 'foot' }, status, ping), h('div', { class: 'actions' }, ready, retry, back)),
    );

    let shownPhase: HostPhase | null = null;
    function show(): void {
      const p = lobby.phase;
      const live = p === 'waiting' || p === 'joined' || p === 'started';
      body.hidden = !live;
      ready.hidden = !live;
      retry.hidden = p !== 'failed';
      code.textContent = lobby.code ?? '';
      card.show(lobby.guest, lobby.ready[1]);
      showReady(ready, lobby.ready[0], p === 'joined');
      status.textContent = hostStatus(lobby);
      keepFocus(el, [ready, copyCode, retry, back], p === shownPhase ? [] : [back, copyCode]);
      shownPhase = p;
    }

    let stopPing = (): void => {};
    return {
      el,
      onShow: () => {
        lobby.open();
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

/** The host lobby's status line. */
function hostStatus<C, M extends { type: string }, S>(lobby: HostLobby<C, M, S>): string {
  switch (lobby.phase) {
    case 'opening':
      return 'Getting a game code…';
    case 'failed':
      return lobby.error === null ? '' : errorText(lobby.error);
    case 'waiting':
      return 'Waiting for opponent…';
    case 'joined':
      return readyStatus(lobby.guest?.name ?? '', lobby.ready, 0);
    case 'started':
      return 'Starting…';
  }
}

// ---------------------------------------------------------------------------------------------
// The join screen

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
 * lobby, the host (name, look, Ready), the match options read-only (the game's labels and values) and
 * the guest's Ready toggle. `?join=CODE` fills the code in with Connect focused; joining removes the
 * parameter from the URL. Errors offer Retry and Back.
 */
export function joinScreen<C, M extends { type: string }, S>(ctx: LobbyContext<C, M, S>, game: LobbyGame<C, M, S>): ScreenFactory {
  return (params) => {
    const { env } = ctx;
    const invite = (params as JoinParams | undefined)?.code ?? null;
    const me = ctx.profile();
    const lobby = new GuestLobby<C, M, S>({
      proto: game.proto,
      join: (code, opts) => env.joinGame(code, opts),
      scheduler: env.scheduler,
      me,
      onChange: () => show(),
      session: (t) => game.guestSession(t, me),
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
    const values = game.optionLabels.map(() => h('span', { class: 'value' }));
    const config = h(
      'div',
      { class: 'rows config' },
      ...game.optionLabels.map((label, i) => h('div', { class: 'row info' }, h('span', { class: 'label' }, label), values[i])),
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
      if (lobby.config !== null) game.optionValues(lobby.config).forEach((v, i) => (values[i]!.textContent = v));
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
function joinStatus<C, M extends { type: string }, S>(lobby: GuestLobby<C, M, S>): string {
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

// ---------------------------------------------------------------------------------------------
// The page during an online match

/** True when the page runs inside another page's frame. */
export function inFrame(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

/**
 * The page's guards while an online match runs (spec §5.3): closing or reloading the page asks first
 * while `session.over` is false, and a page going away (`pagehide`) calls `session.leave()`, which
 * tells the opponent. Returns what removes them.
 */
export function guardOnlineMatch(session: { readonly over: boolean; leave(): void }): () => void {
  const beforeUnload = (e: Event): void => {
    if (session.over) return;
    e.preventDefault();
    // Older browsers ask only when returnValue is set.
    (e as BeforeUnloadEvent).returnValue = '';
  };
  const pageHide = (): void => {
    session.leave();
  };
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('pagehide', pageHide);
  return () => {
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('pagehide', pageHide);
  };
}
