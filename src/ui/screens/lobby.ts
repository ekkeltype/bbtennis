import type { MatchConfig, Profile } from '../../core/types';
import { HostSession } from '../../game/hostSession';
import { HostLobby, type HostPhase } from '../../net/lobby';
import { errorText } from '../../net/peer';
import { APP_ID, PROTO, type NetMsg } from '../../net/protocol';
import { button, panel, spinner } from '../controls';
import { focusables, h } from '../dom';
import { icon } from '../icons';
import { humanPlayer } from '../players';
import { LookPreview } from '../preview';
import type { ScreenFactory } from '../router';
import { DEFAULT_PROFILE } from '../settings';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, PACK_CHOICES, SURFACE_CHOICES } from '../options';
import type { OnlineContext } from './online';

/** How often a lobby screen refreshes the round trip it shows. */
export const PING_REFRESH_MS = 500;

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

/** The typing game's host lobby (net/lobby HostLobby): its HostSession keeps the seed, which never leaves. */
type TypingHostLobby = HostLobby<MatchConfig, NetMsg, HostSession>;

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
    const lobby: TypingHostLobby = new HostLobby({
      proto: { proto: PROTO, app: APP_ID },
      host: (opts) => env.hostGame(opts),
      scheduler: env.scheduler,
      seed: () => env.seed(),
      me: deps.profile(),
      config: { format: st.format, pace: st.pace, surface: st.surface, wordPack: st.wordPack, deuceRule: st.deuceRule, training: null },
      onChange: () => show(),
      session: (t, start) =>
        new HostSession({
          transport: t,
          config: start.config,
          host: humanPlayer(start.me),
          guest: { name: start.guest.name, look: { ...start.guest.look }, kind: 'remote', cpuLevel: null },
          seed: start.seed,
          scheduler: env.scheduler,
          ticker: env.ticker,
        }),
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
function hostStatus(lobby: TypingHostLobby): string {
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
