import type { MatchState, PlayerId } from '../core/types';
import type { Departure } from '../game/onlineLink';
import type { Router } from './router';
import type { Belt, Career, Profile, Settings } from './settings';

/** What kind of match is running: vs CPU, Training or online. */
export type MatchKind = 'cpu' | 'training' | 'online';

/**
 * Params of the Results screen: a finished match, or how a Training session ended. Online:
 * `opponentGone`, the opponent has gone ('left' or 'disconnect'), so Rematch is disabled and a note
 * says "OPPONENT LEFT" / "OPPONENT DISCONNECTED"; `endedBy`, their going cut the match short, so the
 * banner says it instead of a winner (spec §5.3). vs CPU: `newBelt`, a belt colour the match earned;
 * `newLevel`, a level with stripes or a dan grade won for the first time (spec §3.11).
 */
export type ResultsParams =
  | {
      kind: 'cpu' | 'online';
      result: MatchState;
      viewer: PlayerId;
      newBelt: Belt | null;
      newLevel?: number;
      canRematch: boolean;
      opponentGone?: Departure;
      endedBy?: Departure;
    }
  | { kind: 'training'; done: boolean };

/** Params of the in-match menu. */
export interface PauseParams { kind: MatchKind }

/**
 * The app as the screens see it (implemented by `App`): the player's stored data, and the actions
 * the menus trigger. Screens never touch sessions, audio or storage directly.
 */
export interface UiContext {
  readonly router: Router;
  /** Current settings (read-only here; change them through `setSettings`). */
  readonly settings: Readonly<Settings>;
  readonly profile: Readonly<Profile>;
  readonly career: Readonly<Career>;
  /** Applies and stores a settings change (volumes, voice, display and prefs take effect at once). */
  setSettings(patch: Partial<Settings>): void;
  /** Stores the profile; `headbandChosen` marks the headband as the player's own choice (no more belt default). */
  setProfile(profile: Profile, headbandChosen: boolean): void;
  /** True when a local English umpire voice exists (the Options toggle is disabled otherwise). */
  voiceAvailable(): boolean;
  /** The start-gate gesture: focuses the window, unlocks audio and speech, then moves on. */
  openGate(): void;
  startCpuMatch(): void;
  startTraining(): void;
  /** True while the main menu offers Training to a new player (spec §3.12: first launch, until dismissed or done). */
  trainingOffered(): boolean;
  /** The player put the Training offer off (Later): it is not shown again. */
  dismissTrainingOffer(): void;
  /** Rematch from Results: the same match again with a new seed (vs CPU), or the online rematch request. */
  rematch(): void;
  /** Opens the in-match menu (and pauses a local match). */
  pauseMatch(): void;
  resumeMatch(): void;
  /** Restarts the current local match: new seed and coin toss, same config. */
  restartMatch(): void;
  /** Leaves the current match (one still being played is not recorded) and returns to the main menu. */
  quitMatch(): void;
  /** Online: gives the match up. */
  forfeitMatch(): void;
  /** Enters or leaves fullscreen. */
  toggleFullscreen(): void;
  /** Puts the keyboard focus back on the game (a click on the match, or the online focus-lost overlay). */
  focusGame(): void;
}
