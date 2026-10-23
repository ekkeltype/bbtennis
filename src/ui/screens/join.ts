import type { MatchConfig } from '../../core/types';
import { GuestSession } from '../../game/guestSession';
import { ALPHABET, normalizeCode } from '../../net/codes';
import { GuestLobby, type JoinPhase } from '../../net/lobby';
import { APP_ID, PROTO, type NetMsg } from '../../net/protocol';
import { button, panel, type Choice } from '../controls';
import { h } from '../dom';
import { humanPlayer } from '../players';
import type { ScreenFactory } from '../router';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, PACK_CHOICES, SURFACE_CHOICES } from '../options';
import { keepFocus, OpponentCard, PING_REFRESH_MS, pingText, readyButton, readyStatus, showReady } from './lobby';
import type { JoinParams, OnlineContext } from './online';

/** The typing game's guest lobby (net/lobby GuestLobby). */
type TypingGuestLobby = GuestLobby<MatchConfig, NetMsg, GuestSession>;

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
    const me = deps.profile();
    const lobby: TypingGuestLobby = new GuestLobby({
      proto: { proto: PROTO, app: APP_ID },
      join: (code, opts) => env.joinGame(code, opts),
      scheduler: env.scheduler,
      me,
      onChange: () => show(),
      session: (t) => new GuestSession({ transport: t, scheduler: env.scheduler, me: humanPlayer(me), ticker: env.ticker }),
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
function joinStatus(lobby: TypingGuestLobby): string {
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
