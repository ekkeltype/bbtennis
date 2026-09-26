import type { MatchConfig, Profile } from '../../core/types';
import { HostSession } from '../../game/hostSession';
import { LobbyLink } from '../../game/onlineLink';
import { errorText, NetError, type HostHandle } from '../../net/peer';
import { APP_ID, PROTO, type NetMsg } from '../../net/protocol';
import type { Transport } from '../../net/transport';
import { button, panel, spinner } from '../controls';
import { focusables, h } from '../dom';
import { icon } from '../icons';
import { humanPlayer } from '../players';
import { LookPreview } from '../preview';
import type { ScreenFactory } from '../router';
import { DEFAULT_PROFILE } from '../settings';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, PACK_CHOICES, SURFACE_CHOICES } from '../options';
import type { OnlineContext, OnlineEnv } from './online';

/** How often a lobby screen refreshes the round trip it shows. */
export const PING_REFRESH_MS = 500;

type HelloMsg = Extract<NetMsg, { type: 'hello' }>;

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
 * Copies `text` to the clipboard (spec §8): with the Clipboard API; without it, from a hidden
 * textarea with execCommand('copy') inside the same click; when the API refuses, execCommand still.
 * Resolves false when nothing worked (the caller then selects the text for Ctrl+C).
 */
function copyText(text: string): Promise<boolean> {
  const api = navigator.clipboard as Clipboard | undefined;
  if (typeof api?.writeText !== 'function') return Promise.resolve(execCopy(text));
  return api.writeText(text).then(
    () => true,
    () => execCopy(text),
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

/** What the host lobby is doing: getting a code, waiting for a guest, with a guest, failed, or handed to the match. */
export type HostPhase = 'opening' | 'waiting' | 'joined' | 'failed' | 'started';

/** How to set up a host lobby. */
export interface HostLobbyOptions {
  env: OnlineEnv;
  /** The host's name and look. */
  me: Profile;
  /** The match config it starts with (the settings' choices). */
  config: MatchConfig;
  /** Something shown has changed. */
  onChange(): void;
  /** Both are ready: the new match's session, and what releases the game code once the match is done. */
  onStart(session: HostSession, release: () => void): void;
}

/**
 * The host side of the lobby (spec §4.6, §5.3). It registers a game code and admits one guest:
 * `hello` → `welcome`, or `reject` with 'version' (another protocol), 'in-match' (the match has
 * started) or 'full' (a guest is in), after which that connection closes. The host edits the match
 * config; each change clears both Ready flags, and every change of config or Ready reaches the guest
 * as `lobby{config, ready}`. Once both are ready the guest's transport goes to a new HostSession,
 * which sends `start` itself; the lobby hears nothing more from it. The code stays registered during
 * the match, turning later guests away, until `release`.
 */
export class HostLobby {
  phase: HostPhase = 'opening';
  /** The game code, once registered. */
  code: string | null = null;
  /** Why registering failed ('failed'). */
  error: NetError | null = null;
  /** The admitted guest's name and look. */
  guest: Profile | null = null;
  config: MatchConfig;
  /** Ready flags: [host, guest]. */
  ready: [boolean, boolean] = [false, false];
  private abort: AbortController | null = null;
  private handle: HostHandle | null = null;
  /** The admitted guest's link. */
  private link: LobbyLink | null = null;
  /** Guests that have not said hello yet. */
  private readonly pending = new Set<LobbyLink>();

  constructor(private readonly o: HostLobbyOptions) {
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
    this.o.env.hostGame({ signal: abort.signal }).then(
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
  setConfig(patch: Partial<MatchConfig>): void {
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
    for (const l of this.pending) l.close();
    this.pending.clear();
    this.link?.close();
    this.link = null;
    this.handle?.close();
    this.handle = null;
  }

  /** A guest's connection is open: it has a lobby link until its hello is answered. */
  private admit(t: Transport): void {
    const link: LobbyLink = new LobbyLink(t, this.o.env.scheduler, {
      message: (m) => this.onMessage(link, m),
      gone: () => this.onGone(link),
    });
    this.pending.add(link);
    link.open();
  }

  private onMessage(link: LobbyLink, m: NetMsg): void {
    if (m.type === 'hello') {
      if (this.pending.delete(link)) this.hello(link, m);
      return;
    }
    if (link !== this.link || this.phase !== 'joined' || m.type !== 'ready') return;
    this.ready = [this.ready[0], m.on];
    this.sendLobby();
    this.maybeStart();
    this.o.onChange();
  }

  /** Welcomes the guest, or rejects it (version, match on, lobby full) and closes its connection. */
  private hello(link: LobbyLink, m: HelloMsg): void {
    const reason = m.proto !== PROTO || m.app !== APP_ID ? 'version' : this.phase === 'started' ? 'in-match' : this.link !== null ? 'full' : null;
    if (reason !== null) {
      link.send({ type: 'reject', reason, proto: PROTO, app: APP_ID });
      link.close();
      return;
    }
    this.link = link;
    this.guest = { name: m.name, look: m.look };
    this.ready = [false, false];
    this.phase = 'joined';
    link.send({ type: 'welcome', proto: PROTO, hostProfile: this.o.me, config: this.config });
    this.o.onChange();
  }

  /** A guest went away: a pending one is forgotten; the admitted one frees the lobby for the next. */
  private onGone(link: LobbyLink): void {
    this.pending.delete(link);
    if (link !== this.link || this.phase !== 'joined') return;
    link.close();
    this.link = null;
    this.guest = null;
    this.ready = [false, false];
    this.phase = 'waiting';
    this.o.onChange();
  }

  private sendLobby(): void {
    if (this.phase === 'joined') this.link?.send({ type: 'lobby', config: this.config, ready: this.ready });
  }

  /** Both are ready: the guest's transport goes to the match session (seeded here; the seed never leaves). */
  private maybeStart(): void {
    const { link, guest } = this;
    if (this.phase !== 'joined' || !this.ready[0] || !this.ready[1] || link === null || guest === null) return;
    this.phase = 'started';
    const e = this.o.env;
    const session = new HostSession({
      transport: link.handOver(),
      config: this.config,
      host: humanPlayer(this.o.me),
      guest: { name: guest.name, look: { ...guest.look }, kind: 'remote', cpuLevel: null },
      seed: e.seed(),
      scheduler: e.scheduler,
      ticker: e.ticker,
    });
    this.o.onStart(session, () => this.close());
  }
}

/**
 * Host lobby screen (spec §4.6, §8): the game code at 2× with Copy code and Copy invite link
 * (`${VITE_PUBLIC_URL}?join=CODE`, hidden when unset, "Copy browser invite link" inside an iframe),
 * the guest once one joins (name, look, Ready), the match config the host edits (defaults from the
 * settings), both Ready flags and the round trip. Registering errors offer Retry and Back; Back
 * leaves the lobby.
 */
export function hostLobbyScreen(ctx: OnlineContext): ScreenFactory {
  return () => {
    const { deps, env } = ctx;
    const st = deps.settings();
    const lobby = new HostLobby({
      env,
      me: deps.profile(),
      config: { format: st.format, pace: st.pace, surface: st.surface, wordPack: st.wordPack, deuceRule: st.deuceRule, training: null },
      onChange: () => show(),
      onStart: (session, release) => ctx.begin(session, release),
    });

    const code = h('span', { class: 'code big selectable' });
    const link = h('span', { class: 'invite-url selectable', hidden: true });
    const note = h('p', { class: 'copy-note' });
    const copy = (text: string, el: HTMLElement, done: string): void => {
      void copyText(text).then((ok) => {
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
    const set = (patch: Partial<MatchConfig>): void => lobby.setConfig(patch);
    const rows = h(
      'div',
      { class: 'rows' },
      spinner({ label: 'FORMAT', choices: FORMAT_CHOICES, get: () => lobby.config.format, set: (format) => set({ format }) }),
      spinner({ label: 'PACE', choices: PACE_CHOICES, get: () => lobby.config.pace, set: (pace) => set({ pace }) }),
      spinner({ label: 'COURT', choices: SURFACE_CHOICES, get: () => lobby.config.surface, set: (surface) => set({ surface }) }),
      spinner({ label: 'WORDS', choices: PACK_CHOICES, get: () => lobby.config.wordPack, set: (wordPack) => set({ wordPack }) }),
      spinner({ label: 'DEUCE', choices: DEUCE_CHOICES, get: () => lobby.config.deuceRule, set: (deuceRule) => set({ deuceRule }) }),
    );
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
function hostStatus(lobby: HostLobby): string {
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
