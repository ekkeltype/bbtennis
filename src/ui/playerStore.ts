import type { MatchState } from '../core/types';
import { recordCpuMatch } from './matchLifecycle';
import {
  DEFAULT_CAREER,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  isCareer,
  isProfile,
  isSettings,
  offerTraining,
  type Belt,
  type Career,
  type Profile,
  type Settings,
} from './settings';
import { load, save } from './storage';

const clone = <T>(v: T): T => structuredClone(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * The player's stored data (spec §5.4): settings, profile and career, plus two flags: the headband is
 * the player's own choice (no more earned-belt default), and the first-launch Training offer was put
 * off. Loaded once (invalid or unreadable values fall back to the defaults), stored on every change.
 */
export class PlayerStore {
  settings: Settings;
  profile: Profile;
  career: Career;
  /** No valid settings were stored before this visit: spec §3.12's first launch. */
  readonly firstLaunch: boolean;
  private headbandChosen: boolean;
  private offerDismissed: boolean;

  constructor() {
    const settings = load<Settings | null>('settings', null, isSettings);
    this.firstLaunch = settings === null;
    this.settings = settings ?? clone(DEFAULT_SETTINGS);
    this.profile = load('profile', clone(DEFAULT_PROFILE), isProfile);
    this.career = load('career', clone(DEFAULT_CAREER), isCareer);
    this.headbandChosen = load('headbandChosen', false, isBoolean);
    this.offerDismissed = load('trainingOfferDismissed', false, isBoolean);
  }

  /** Applies and stores a settings change. */
  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...clone(patch) };
    save('settings', this.settings);
  }

  /** Stores the profile; `headbandChosen` marks its headband as the player's own choice, for good. */
  setProfile(profile: Profile, headbandChosen: boolean): void {
    this.profile = clone(profile);
    save('profile', this.profile);
    if (headbandChosen && !this.headbandChosen) {
      this.headbandChosen = true;
      save('headbandChosen', true);
    }
  }

  /** Stores what a finished vs-CPU match at `level` changes (see `recordCpuMatch`); returns the belt it earned, or null. */
  recordCpuMatch(level: number, result: MatchState): Belt | null {
    const look = this.profile.look;
    const progress = { career: this.career, matchesPlayed: this.settings.matchesPlayed, headband: look.headband, headbandChosen: this.headbandChosen };
    const r = recordCpuMatch(progress, level, result);
    this.career = r.career;
    save('career', this.career);
    this.setSettings({ matchesPlayed: r.matchesPlayed });
    if (r.headband !== look.headband) this.setProfile({ ...this.profile, look: { ...look, headband: r.headband } }, false);
    return r.newBelt;
  }

  /** True while the main menu offers Training (see `offerTraining`). */
  trainingOffered(): boolean {
    return offerTraining({ firstLaunch: this.firstLaunch, dismissed: this.offerDismissed, trainingDone: this.settings.trainingDone });
  }

  /** The player put the Training offer off (Later): it is not shown again. */
  dismissTrainingOffer(): void {
    this.offerDismissed = true;
    save('trainingOfferDismissed', true);
  }
}
