import type { KeyClass } from '../../core/typing';
import type { MatchState, ViewModel } from '../../core/types';
import { RealScheduler, type Scheduler } from '../../game/clock';
import type { Departure, Ticker } from '../../game/onlineLink';
import type { Session } from '../../game/session';
import { hostGame, joinGame, type HostHandle, type PeerEnv } from '../../net/peer';
import type { Transport } from '../../net/transport';
import { randomSeed } from '../attract';
import type { Router } from '../router';
import type { Profile, Settings } from '../settings';
import { joinScreen } from './join';
import { hostLobbyScreen } from './lobby';

/**
 * What an online match hands the app besides its session: how to forfeit, and how to ask for a
 * rematch. `rematch` is there only while a rematch can still happen: it reads undefined once the
 * opponent has left or the connection is lost.
 */
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

/** The network and page the online screens work with; the browser's by default, a test's own in tests. */
export interface OnlineEnv {
  /** Registers a game code (spec §5.3). */
  hostGame(opts: PeerEnv): Promise<HostHandle>;
  /** Connects to the host of a game code (spec §5.3). */
  joinGame(code: string, opts: PeerEnv): Promise<Transport>;
  /** Time and timers of the lobbies and the matches. */
  scheduler: Scheduler;
  /** Runs a match session's 50 ms tick; unset, the sessions use their Worker ticker. */
  ticker?: Ticker;
  /** A fresh seed for the host's match. */
  seed(): number;
  /** Where invite links point (VITE_PUBLIC_URL); null or empty: there is no invite link. */
  publicUrl: string | null;
  /** True inside an iframe (itch.io), where the invite link is the browser (Pages) build's (spec §8). */
  framed: boolean;
}

/** An online session (HostSession or GuestSession) as the screens and the app's controls use it. */
export interface OnlineSession extends Session {
  forfeit(): void;
  rematch(): void;
  leave(): void;
  readonly opponentGone: Departure | null;
}

/** What the host lobby and join screens get from registerOnlineScreens. */
export interface OnlineContext {
  router: Router;
  deps: OnlineDeps;
  env: OnlineEnv;
  /** Hands a started match to the app, guarded while it runs; `release` runs once the app has disposed of it. */
  begin(session: OnlineSession, release: () => void): void;
}

/** True when the page runs inside another page's frame. */
function inFrame(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

/** The browser's online environment: PeerJS, the page clock, crypto seeds and the build's invite URL. */
export function browserEnv(): OnlineEnv {
  const url: unknown = import.meta.env.VITE_PUBLIC_URL;
  return {
    hostGame,
    joinGame,
    scheduler: new RealScheduler(),
    seed: randomSeed,
    publicUrl: typeof url === 'string' && url.trim() !== '' ? url.trim() : null,
    framed: inFrame(),
  };
}

/**
 * An online match as the app runs it (spec §5.3): the session, with the page's guards while it is
 * played. Closing or reloading the page asks first, and a page going away (`pagehide`) tells the
 * opponent with `leave`. Disposing it removes the guards, disposes the session and runs `release`.
 */
class OnlineMatch implements Session {
  private disposed = false;

  constructor(
    private readonly session: OnlineSession,
    private readonly release: () => void,
  ) {
    window.addEventListener('beforeunload', this.beforeUnload);
    window.addEventListener('pagehide', this.pageHide);
  }

  get over(): boolean {
    return this.session.over;
  }

  get result(): MatchState | null {
    return this.session.result;
  }

  get view(): ViewModel | null {
    return this.session.view;
  }

  frame(dtMs: number): ViewModel {
    return this.session.frame(dtMs);
  }

  key(k: KeyClass, timeStamp: number): void {
    this.session.key(k, timeStamp);
  }

  pause(): void {
    this.session.pause();
  }

  resume(): void {
    this.session.resume();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('beforeunload', this.beforeUnload);
    window.removeEventListener('pagehide', this.pageHide);
    this.session.dispose();
    this.release();
  }

  private readonly beforeUnload = (e: Event): void => {
    if (this.session.over) return;
    e.preventDefault();
    // Older browsers ask only when returnValue is set.
    (e as BeforeUnloadEvent).returnValue = '';
  };

  private readonly pageHide = (): void => {
    this.session.leave();
  };
}

/**
 * Registers the online screens 'host' (Host lobby) and 'join' (Join) of spec §4.6. Each hands the
 * match it starts to `deps.startMatch` with its controls: forfeit, and a rematch while the opponent is
 * still there. `env` defaults to the browser's (PeerJS, VITE_PUBLIC_URL).
 */
export function registerOnlineScreens(router: Router, deps: OnlineDeps, env: OnlineEnv = browserEnv()): void {
  const begin = (session: OnlineSession, release: () => void): void => {
    const controls: OnlineControls = {
      forfeit: () => session.forfeit(),
      get rematch() {
        return session.opponentGone === null ? () => session.rematch() : undefined;
      },
    };
    deps.startMatch(new OnlineMatch(session, release), controls);
  };
  const ctx: OnlineContext = { router, deps, env, begin };
  router.register('host', hostLobbyScreen(ctx));
  router.register('join', joinScreen(ctx));
}
