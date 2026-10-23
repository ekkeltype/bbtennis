import type { MatchConfig } from '../../core/types';
import { GuestSession } from '../../game/guestSession';
import { HostSession } from '../../game/hostSession';
import { APP_ID, PROTO, type NetMsg } from '../../net/protocol';
import { spinner, type Choice } from '../controls';
import type { LobbyContext, LobbyGame } from '../lobbyScreens';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, PACK_CHOICES, SURFACE_CHOICES } from '../options';
import { humanPlayer } from '../players';
import type { OnlineContext, OnlineEnv, OnlineSession } from './online';

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

/**
 * The typing game's lobby (spec §4.6, §5.3) for the shared host lobby and join screens (ui/lobbyScreens):
 * PROTO and APP_ID; the match config's FORMAT, PACE, COURT, WORDS and DEUCE, as spinners for the host
 * and read-only rows for the guest; and the match's HostSession (which keeps the seed: it never leaves
 * the host) and GuestSession, on `env`'s scheduler and ticker.
 */
export function typingLobby(env: OnlineEnv): LobbyGame<MatchConfig, NetMsg, OnlineSession> {
  return {
    proto: { proto: PROTO, app: APP_ID },
    optionRows: (get, set) => [
      spinner({ label: 'FORMAT', choices: FORMAT_CHOICES, get: () => get().format, set: (format) => set({ format }) }),
      spinner({ label: 'PACE', choices: PACE_CHOICES, get: () => get().pace, set: (pace) => set({ pace }) }),
      spinner({ label: 'COURT', choices: SURFACE_CHOICES, get: () => get().surface, set: (surface) => set({ surface }) }),
      spinner({ label: 'WORDS', choices: PACK_CHOICES, get: () => get().wordPack, set: (wordPack) => set({ wordPack }) }),
      spinner({ label: 'DEUCE', choices: DEUCE_CHOICES, get: () => get().deuceRule, set: (deuceRule) => set({ deuceRule }) }),
    ],
    optionLabels: CONFIG_LABELS,
    optionValues: configValues,
    hostSession: (t, start) =>
      new HostSession({
        transport: t,
        config: start.config,
        host: humanPlayer(start.me),
        guest: { name: start.guest.name, look: { ...start.guest.look }, kind: 'remote', cpuLevel: null },
        seed: start.seed,
        scheduler: env.scheduler,
        ticker: env.ticker,
      }),
    guestSession: (t, me) => new GuestSession({ transport: t, scheduler: env.scheduler, me: humanPlayer(me), ticker: env.ticker }),
  };
}

/** The shared lobby screens' context for the typing game: the profile, the settings' choices as the host's starting config, the env and `begin`. */
export function lobbyContext(ctx: OnlineContext): LobbyContext<MatchConfig, NetMsg, OnlineSession> {
  const { router, deps, env } = ctx;
  return {
    router,
    profile: () => deps.profile(),
    config: () => {
      const st = deps.settings();
      return { format: st.format, pace: st.pace, surface: st.surface, wordPack: st.wordPack, deuceRule: st.deuceRule, training: null };
    },
    env,
    begin: (session, release) => ctx.begin(session, release),
  };
}
