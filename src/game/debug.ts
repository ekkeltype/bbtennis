import type { ViewModel } from '../core/types';
import type { Session } from './session';

/** The active prompt of the current turn as the E2E script types it. */
export interface ActiveWords { words: string[]; locked: number | null; typed: number; kind: string }

/** `window.__bbt`: read-only views of the running session for the E2E script. */
export interface DebugHooks {
  /** The latest frame's view model, or null without a session or before its first frame. */
  view(): ViewModel | null;
  /** The viewer's open early chase (kind 'early'), else the current turn's active prompt (serve words stay hidden from a non-owner), or null. */
  activeWords(): ActiveWords | null;
  /** Owner of the current turn while the match is being played, else null. */
  owner(): 0 | 1 | null;
  /**
   * 'none', 'paused', 'countdown', 'matchOver' (the MATCH_OVER celebration), 'over' (time for
   * Results), 'leadIn:intro' | 'leadIn:fault' | 'leadIn:point' | 'leadIn:none', or the turn's phase.
   */
  status(): string;
}

/** The page as installDebugHooks sees it: its query string, and where the hooks go. */
export interface DebugHost { location: { search: string }; __bbt?: DebugHooks }

declare global {
  interface Window {
    __bbt?: DebugHooks;
  }
}

/**
 * Sets `host.__bbt` (default `window.__bbt`) for the E2E script, only when the URL has `?e2e=1` or in
 * dev mode; returns the hooks, or null when not installed. `getSession` is read on every call, so the
 * hooks follow the app from session to session.
 */
export function installDebugHooks(
  getSession: () => Session | null,
  host: DebugHost = window,
  dev: boolean = import.meta.env.DEV,
): DebugHooks | null {
  if (!dev && new URLSearchParams(host.location.search).get('e2e') !== '1') return null;
  const view = (): ViewModel | null => getSession()?.view ?? null;
  const hooks: DebugHooks = {
    view,
    activeWords: () => {
      const vm = view();
      const e = vm?.early ?? null;
      if (vm !== null && e !== null && e.player === vm.viewer) {
        return { words: [e.prompt.options[0]?.word ?? ''], locked: 0, typed: e.prompt.typed, kind: 'early' };
      }
      const t = vm === null ? null : vm.liveTurn ?? vm.pub.turn;
      const p = t === null || t.active === null ? undefined : t.prompts[t.active];
      if (p === undefined) return null;
      return { words: p.options.map((o) => o.word), locked: p.locked, typed: p.typed, kind: p.kind };
    },
    owner: () => {
      const vm = view();
      return vm === null || vm.pub.status !== 'playing' || vm.pub.turn === null ? null : vm.pub.turn.data.owner;
    },
    status: () => status(getSession()),
  };
  host.__bbt = hooks;
  return hooks;
}

function status(session: Session | null): string {
  const vm = session?.view ?? null;
  if (session === null || vm === null) return 'none';
  if (session.over) return 'over';
  if (vm.pub.status === 'over') return 'matchOver';
  if (vm.overlay.countdown !== null) return 'countdown';
  if (vm.overlay.paused) return 'paused';
  const t = vm.liveTurn ?? vm.pub.turn;
  if (t === null) return 'none';
  return t.data.kind === 'serve' && t.phase === 'leadIn' ? `leadIn:${t.data.leadIn.kind}` : t.phase;
}
