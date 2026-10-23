import type { Profile } from '../../core/types';
import { RealScheduler } from '../../game/clock';
import type { Transport } from '../../net/channel';
import { hostRtc, joinRtc, type HostHandle, type PeerEnv } from '../../net/rtc';
import { spinner } from '../../ui/controls';
import { inFrame, type LobbyEnv, type LobbyGame } from '../../ui/lobbyScreens';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, SURFACE_CHOICES } from '../../ui/options';
import { randomSeed } from '../../ui/seed';
import type { ArcadeConfig, Controller } from '../core/types';
import { laggy } from '../game/lag';
import { ArcadeOnlineSession, type Ticker } from '../game/onlineSession';
import { APP_ID, ARCADE_RTC, PROTO, type ArcadeMsg } from '../net/protocol';

/** The network, clock and page an Arcade lobby and online match work with; the browser's by default, a test's own in tests. */
export interface ArcadeOnlineEnv extends LobbyEnv<ArcadeMsg> {
  /** Runs an online session's pump; unset, sessions use their Worker ticker. */
  ticker?: Ticker;
}

/** The pace presets without the typing game's WPM hints (as on the CPU setup screen). */
const PACES = PACE_CHOICES.map(({ value, label }) => ({ value, label }));

/** The name of `v` among `choices`. */
function labelOf<T>(choices: readonly { value: T; label: string }[], v: T): string {
  return choices.find((c) => c.value === v)?.label ?? '';
}

/**
 * The browser's online environment for the Arcade (online spec §1.2, §5): PeerJS with the Arcade's
 * codec and game-code namespace, the page clock, crypto seeds, and invite links to
 * `<VITE_PUBLIC_URL>arcade/`. `lagMs` (debug `?lag=`) holds back everything this page sends.
 */
export function arcadeBrowserEnv(lagMs = 0): ArcadeOnlineEnv {
  const scheduler = new RealScheduler();
  const url: unknown = import.meta.env.VITE_PUBLIC_URL;
  const lag = (t: Transport<ArcadeMsg>): Transport<ArcadeMsg> => (lagMs > 0 ? laggy(t, lagMs, scheduler) : t);
  return {
    hostGame: async (opts: PeerEnv): Promise<HostHandle<ArcadeMsg>> => {
      const handle = await hostRtc(ARCADE_RTC, opts);
      return { code: handle.code, onGuest: (cb) => handle.onGuest((t) => cb(lag(t))), close: () => handle.close() };
    },
    joinGame: async (code: string, opts: PeerEnv) => lag(await joinRtc(ARCADE_RTC, code, opts)),
    scheduler,
    seed: randomSeed,
    publicUrl: typeof url === 'string' && url.trim() !== '' ? `${url.trim()}arcade/` : null,
    framed: inFrame(),
  };
}

/**
 * The Arcade as the shared lobby screens see it (online spec §5): its protocol, its four match options
 * (format, deuce rule, court, pace) and its sessions, which play this side's player from `controller`.
 */
export function arcadeLobbyGame(env: ArcadeOnlineEnv, controller: Controller): LobbyGame<ArcadeConfig, ArcadeMsg, ArcadeOnlineSession> {
  return {
    proto: { proto: PROTO, app: APP_ID },
    optionRows: (get, set) => [
      spinner({ label: 'FORMAT', choices: FORMAT_CHOICES, get: () => get().format, set: (format) => set({ format }) }),
      spinner({ label: 'DEUCE', choices: DEUCE_CHOICES, get: () => get().deuceRule, set: (deuceRule) => set({ deuceRule }) }),
      spinner({ label: 'COURT', choices: SURFACE_CHOICES, get: () => get().surface, set: (surface) => set({ surface }) }),
      spinner({ label: 'PACE', choices: PACES, get: () => get().pace, set: (pace) => set({ pace }) }),
    ],
    optionLabels: ['FORMAT', 'DEUCE', 'COURT', 'PACE'],
    optionValues: (c) => [labelOf(FORMAT_CHOICES, c.format), labelOf(DEUCE_CHOICES, c.deuceRule), labelOf(SURFACE_CHOICES, c.surface), labelOf(PACES, c.pace)],
    hostSession: (transport, start) =>
      new ArcadeOnlineSession({
        transport,
        scheduler: env.scheduler,
        controller,
        host: { first: { config: start.config, seed: start.seed, players: [start.me, start.guest] }, seed: () => env.seed() },
        ticker: env.ticker,
      }),
    guestSession: (transport, _me: Profile) => new ArcadeOnlineSession({ transport, scheduler: env.scheduler, controller, host: null, ticker: env.ticker }),
  };
}
