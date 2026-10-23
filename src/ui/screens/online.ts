import type { KeyClass } from '../../core/typing';
import type { MatchState, ViewModel } from '../../core/types';
import { RealScheduler } from '../../game/clock';
import type { Departure, EndReason, Ticker } from '../../game/onlineLink';
import type { Session } from '../../game/session';
import { hostGame, joinGame } from '../../net/peer';
import type { NetMsg } from '../../net/protocol';
import { guardOnlineMatch, hostLobbyScreen, inFrame, joinScreen, type LobbyEnv } from '../lobbyScreens';
import type { Router } from '../router';
import { randomSeed } from '../seed';
import type { Profile, Settings } from '../settings';
import { lobbyContext, typingLobby } from './lobby';

export type { JoinParams } from '../lobbyScreens';

/**
 * What an online match hands the app besides its session: how to forfeit, how to ask for a rematch,
 * and how the match and the opponent are doing. `rematch` is there only while a rematch can still
 * happen: it reads undefined once the opponent has left or the connection is lost.
 */
export interface OnlineControls {
  forfeit(): void;
  rematch?(): void;
  /** Why the match ended, or null while it is played. */
  readonly endReason: EndReason | null;
  /** How the opponent went away, or null while connected. */
  readonly opponentGone: Departure | null;
}

/** What the online screens need from the app. */
export interface OnlineDeps {
  /** The local player's name and look. */
  profile(): Profile;
  /** Current settings (default pace, word pack, deuce rule for the host's lobby). */
  settings(): Settings;
  /** Hands a started online session to the app, which shows and drives it like any match. */
  startMatch(session: Session, controls: OnlineControls): void;
}

/**
 * The network and page the online screens work with (ui/lobbyScreens LobbyEnv for the typing game's
 * messages); the browser's by default, a test's own in tests.
 */
export interface OnlineEnv extends LobbyEnv<NetMsg> {
  /** Runs a match session's 50 ms tick; unset, the sessions use their Worker ticker. */
  ticker?: Ticker;
}

/** An online session (HostSession or GuestSession) as the screens and the app's controls use it. */
export interface OnlineSession extends Session {
  forfeit(): void;
  rematch(): void;
  leave(): void;
  readonly endReason: EndReason | null;
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
 * played (guardOnlineMatch). Closing or reloading the page asks first, and a page going away
 * (`pagehide`) tells the opponent with `leave`. Disposing it removes the guards, disposes the session
 * and runs `release`.
 */
class OnlineMatch implements Session {
  private disposed = false;
  /** Removes the page's guards. */
  private readonly unguard: () => void;

  constructor(
    private readonly session: OnlineSession,
    private readonly release: () => void,
  ) {
    this.unguard = guardOnlineMatch(session);
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
    this.unguard();
    this.session.dispose();
    this.release();
  }
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
      get endReason() {
        return session.endReason;
      },
      get opponentGone() {
        return session.opponentGone;
      },
    };
    deps.startMatch(new OnlineMatch(session, release), controls);
  };
  const ctx: OnlineContext = { router, deps, env, begin };
  const lobby = lobbyContext(ctx);
  const game = typingLobby(env);
  router.register('host', hostLobbyScreen(lobby, game));
  router.register('join', joinScreen(lobby, game));
}
