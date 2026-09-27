import type { MatchState } from '../core/types';
import { BELT_COLOR } from '../render/palette';
import { recordCpuMatch, type CpuCredit } from './matchLifecycle';
import {
  creditBeatenLevels,
  DEFAULT_CAREER,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  highestBelt,
  isCareer,
  isProfile,
  isSettings,
  offerTraining,
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
 * off. Loaded once (invalid or unreadable values fall back to the defaults), stored on every change;
 * the first change that can't be stored (blocked storage, a full quota) calls `onSaveFailed`, once,
 * and play goes on with the change kept for this visit.
 */
export class PlayerStore {
  settings: Settings;
  profile: Profile;
  career: Career;
  /** No valid settings were stored before this visit: spec §3.12's first launch. */
  readonly firstLaunch: boolean;
  private headbandChosen: boolean;
  private offerDismissed: boolean;
  private saveFailed = false;

  constructor(private readonly onSaveFailed: () => void = () => {}) {
    const settings = load<Settings | null>('settings', null, isSettings);
    this.firstLaunch = settings === null;
    this.settings = settings ?? clone(DEFAULT_SETTINGS);
    this.profile = load('profile', clone(DEFAULT_PROFILE), isProfile);
    this.headbandChosen = load('headbandChosen', false, isBoolean);
    this.offerDismissed = load('trainingOfferDismissed', false, isBoolean);
    this.career = load('career', clone(DEFAULT_CAREER), isCareer);
    this.creditBeatenLevels();
  }

  /**
   * Wins stored before every level earned its belt colour (spec §3.11: once only levels without
   * stripes did) earn it now: the career is stored again, and the highest belt becomes the headband
   * unless the player chose one. Nothing is stored when no colour is missing.
   */
  private creditBeatenLevels(): void {
    const credited = creditBeatenLevels(this.career);
    if (credited.earned.length === this.career.earned.length) return;
    this.career = credited;
    this.save('career', this.career);
    const best = highestBelt(credited);
    const look = this.profile.look;
    if (this.headbandChosen || best === null || look.headband === BELT_COLOR[best]) return;
    this.setProfile({ ...this.profile, look: { ...look, headband: BELT_COLOR[best] } }, false);
  }

  /** Applies and stores a settings change. */
  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...clone(patch) };
    this.save('settings', this.settings);
  }

  /** Stores the profile; `headbandChosen` marks its headband as the player's own choice, for good. */
  setProfile(profile: Profile, headbandChosen: boolean): void {
    this.profile = clone(profile);
    this.save('profile', this.profile);
    if (headbandChosen && !this.headbandChosen) {
      this.headbandChosen = true;
      this.save('headbandChosen', true);
    }
  }

  /** Stores what a finished vs-CPU match at `level` changes (see `recordCpuMatch`); returns what it earned. */
  recordCpuMatch(level: number, result: MatchState): CpuCredit {
    const look = this.profile.look;
    const progress = { career: this.career, matchesPlayed: this.settings.matchesPlayed, headband: look.headband, headbandChosen: this.headbandChosen };
    const r = recordCpuMatch(progress, level, result);
    this.career = r.career;
    this.save('career', this.career);
    this.setSettings({ matchesPlayed: r.matchesPlayed });
    if (r.headband !== look.headband) this.setProfile({ ...this.profile, look: { ...look, headband: r.headband } }, false);
    return { newBelt: r.newBelt, ...(r.newLevel !== undefined ? { newLevel: r.newLevel } : {}) };
  }

  /** True while the main menu offers Training (see `offerTraining`). */
  trainingOffered(): boolean {
    return offerTraining({ firstLaunch: this.firstLaunch, dismissed: this.offerDismissed, trainingDone: this.settings.trainingDone });
  }

  /** The player put the Training offer off (Later): it is not shown again. */
  dismissTrainingOffer(): void {
    this.offerDismissed = true;
    this.save('trainingOfferDismissed', true);
  }

  private save(key: string, v: unknown): void {
    if (save(key, v) || this.saveFailed) return;
    this.saveFailed = true;
    this.onSaveFailed();
  }
}
