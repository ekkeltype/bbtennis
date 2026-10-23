import type { Router } from '../../ui/router';
import type { Profile } from '../../ui/settings';
import type { ArcadeConfig } from '../core/types';
import type { ArcadeSettings, CpuSetup } from './store';

/**
 * The Arcade app as its screens see it (implemented by `ArcadeApp`): the saved data and the
 * actions the menus trigger. Screens never touch sessions, keys, audio or storage directly.
 */
export interface ArcadeContext {
  readonly router: Router;
  readonly profile: Readonly<Profile>;
  readonly settings: Readonly<ArcadeSettings>;
  readonly cpuSetup: Readonly<CpuSetup>;
  /** Stores the profile (the shared Customize screen's call; the Arcade has no earned-belt headband, so `headbandChosen` is ignored). */
  setProfile(profile: Profile, headbandChosen: boolean): void;
  /** Applies (volumes at once) and stores a settings change. */
  setSettings(patch: Partial<ArcadeSettings>): void;
  /** Stores a change of the CPU setup screen. */
  setCpuSetup(patch: Partial<CpuSetup>): void;
  /** The start-gate gesture: focuses the window, unlocks audio and speech, then shows the title. */
  openGate(): void;
  /** Starts a match against the CPU at belt `level` (0..14). */
  startCpuMatch(level: number, config: ArcadeConfig): void;
  /** Results' Rematch: vs CPU the same setup with a new seed; online, asks the opponent (online spec §3.6). */
  rematch(): void;
  /** Opens the in-match menu (and pauses a local match). */
  pauseMatch(): void;
  /** Closes the in-match menu: back to the match (a local one resumes after a 3-2-1 countdown). */
  resumeMatch(): void;
  /** Restarts the current match: the same setup with a new seed. */
  restartMatch(): void;
  /** Leaves the current match for the main menu. */
  quitMatch(): void;
  /** Online: gives the match up (online spec §3.6). */
  forfeitMatch(): void;
  toggleFullscreen(): void;
  /** Puts the keyboard focus back on the game (a click on the match). */
  focusGame(): void;
}
