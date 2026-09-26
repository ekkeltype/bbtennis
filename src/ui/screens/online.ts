import type { Session } from '../../game/session';
import { button, panel } from '../controls';
import { h } from '../dom';
import type { Router } from '../router';
import type { Profile, Settings } from '../settings';

/** What an online match hands the app besides its session: how to forfeit and (optionally) ask for a rematch. */
export interface OnlineControls { forfeit(): void; rematch?(): void }

/** What the online screens need from the app. */
export interface OnlineDeps {
  /** The local player's name and look. */
  profile(): Profile;
  /** Current settings (default pace, word pack, deuce rule for the host's lobby). */
  settings(): Settings;
  /** Hands a started online session to the app, which shows and drives it like any match. */
  startMatch(session: Session, controls: OnlineControls): void;
}

/** Params of the Join screen: the code from a `?join=CODE` invite link, if any. */
export interface JoinParams { code: string | null }

/**
 * Registers the online screens 'host' and 'join' (spec §4.6 Host lobby / Join). Branch-internal
 * placeholder (R10): Task 21 replaces this file with the real lobby and join screens, which use
 * `deps` to read the profile and settings and to hand their started session to the app.
 */
export function registerOnlineScreens(router: Router, deps: OnlineDeps): void {
  const stub = (title: string, extra: string | null) => () => ({
    el: h(
      'div',
      { class: 'screen dim' },
      panel(
        title,
        'online',
        h('p', { class: 'message' }, 'Online play is being wired up.'),
        extra === null ? null : h('p', { class: 'message' }, extra),
        h('div', { class: 'actions' }, button('BACK', () => router.back(), 'primary')),
      ),
    ),
  });
  router.register('host', stub('HOST GAME', null));
  router.register('join', (params) => {
    const code = (params as JoinParams | undefined)?.code ?? null;
    return stub('JOIN GAME', code === null ? null : `Invite code: ${code}`)();
  });
}
