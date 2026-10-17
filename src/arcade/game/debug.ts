import { BELTS } from '../../core/belts';
import type { Router } from '../../ui/router';
import type { ArcadeConfig, ArcadeState } from '../core/types';

/** Frames drawn after the hooks are installed before the page reports `__shotReady` (so the canvas has drawn). */
export const SHOT_READY_FRAMES = 45;

/** Screens `screen(name)` and `?screen=` can show, each as if reached from the main menu (past the gate). */
export const DEBUG_SCREENS: readonly string[] = ['title', 'mainMenu', 'cpuSetup', 'customize', 'options', 'howTo', 'match', 'pause'];

/** `window.__arcade`: debug hooks for scripts/arcadeRun.mjs, devshots and the console. */
export interface ArcadeDebugHooks {
  /** A copy of the current match's state (vs CPU or demo, also behind Pause and Results), or null without a match. */
  state(): ArcadeState | null;
  /** Starts a match vs the CPU at belt `level` (0..14) with the saved CPU setup's options and `seed` (random when omitted). */
  startMatch(level: number, seed?: number): void;
  /** Starts a CPU-vs-CPU match on the match screen: a Black-belt CPU on your side against the saved CPU setup. */
  demo(): void;
  /** Shows screen `name` (one of DEBUG_SCREENS) as if reached from the main menu; a match in progress is left first. */
  screen(name: string): void;
}

/** The app as the hooks drive it (ArcadeApp). */
export interface ArcadeDebugTarget {
  readonly router: Pick<Router, 'go'>;
  /** The saved vs-CPU setup: belt level and match options. */
  readonly cpuSetup: Readonly<{ level: number } & ArcadeConfig>;
  /** The current match's live state, or null. */
  matchState(): Readonly<ArcadeState> | null;
  startCpuMatch(level: number, config: ArcadeConfig, seed?: number): void;
  /** Starts the CPU-vs-CPU demo match of `demo()`. */
  startDemoMatch(): void;
  pauseMatch(): void;
  /** Ends the current match and shows the main menu. */
  quitMatch(): void;
}

/** The page as installArcadeDebug sees it: its query string, and where the hooks and the ready flag go. */
export interface ArcadeDebugHost { location: { search: string }; __arcade?: ArcadeDebugHooks; __shotReady?: boolean }

/** What the app keeps of installed hooks: the start screen and the per-frame ready countdown. */
export interface ArcadeDebug {
  readonly hooks: ArcadeDebugHooks;
  /** Shows the page's `?screen=` and returns true; false without one, or (with a warning) for an unknown name. */
  showStartScreen(): boolean;
  /** Called once per animation frame: sets `host.__shotReady` after SHOT_READY_FRAMES frames. */
  frame(): void;
}

declare global {
  interface Window {
    __arcade?: ArcadeDebugHooks;
  }
}

/** The match options of a CPU setup. */
function configOf(s: Readonly<{ level: number } & ArcadeConfig>): ArcadeConfig {
  return { format: s.format, deuceRule: s.deuceRule, surface: s.surface, pace: s.pace };
}

/**
 * Sets `host.__arcade` (default `window.__arcade`) in dev builds and on pages opened with `?debug`,
 * and returns what the app needs each frame; returns null (nothing installed) otherwise. Replaces
 * the app's ad-hoc `?screen=` jump: `?screen=<name>` (dev, or with `?debug`) opens on that screen.
 */
export function installArcadeDebug(
  app: ArcadeDebugTarget,
  host: ArcadeDebugHost = window,
  dev: boolean = import.meta.env.DEV,
): ArcadeDebug | null {
  const q = new URLSearchParams(host.location.search);
  if (!dev && !q.has('debug')) return null;

  const screen = (name: string): void => {
    if (!DEBUG_SCREENS.includes(name)) throw new Error(`__arcade.screen: no screen '${name}' (one of ${DEBUG_SCREENS.join(', ')})`);
    if (app.matchState() !== null) app.quitMatch();
    const r = app.router;
    r.go('title');
    if (name === 'title') return;
    r.go('mainMenu');
    if (name === 'match' || name === 'pause') {
      app.startCpuMatch(app.cpuSetup.level, configOf(app.cpuSetup));
      if (name === 'pause') app.pauseMatch();
    } else if (name !== 'mainMenu') {
      r.go(name);
    }
  };

  const hooks: ArcadeDebugHooks = {
    state: () => {
      const s = app.matchState();
      return s === null ? null : structuredClone(s);
    },
    startMatch: (level, seed) => {
      if (!Number.isInteger(level) || level < 0 || level >= BELTS.length) throw new RangeError(`__arcade.startMatch: belt level ${level} is not 0..${BELTS.length - 1}`);
      if (seed !== undefined && !Number.isInteger(seed)) throw new RangeError(`__arcade.startMatch: seed ${seed} is not an integer`);
      app.startCpuMatch(level, configOf(app.cpuSetup), seed);
    },
    demo: () => app.startDemoMatch(),
    screen,
  };
  host.__arcade = hooks;

  let readyIn = SHOT_READY_FRAMES;
  return {
    hooks,
    showStartScreen: () => {
      const name = q.get('screen');
      if (name === null) return false;
      if (!DEBUG_SCREENS.includes(name)) {
        console.warn(`[arcade] ?screen=${name}: no such screen (one of ${DEBUG_SCREENS.join(', ')})`);
        return false;
      }
      screen(name);
      return true;
    },
    frame: () => {
      if (readyIn <= 0) return;
      if (--readyIn === 0) host.__shotReady = true;
    },
  };
}
