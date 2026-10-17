import type { Volumes } from '../../audio/engine';
import type { DeuceRule, FormatId, PaceId, Surface } from '../../core/types';
import { BELTS } from '../../core/belts';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, SURFACE_CHOICES, valuesOf } from '../../ui/options';
import { DEFAULT_PROFILE, isProfile, type Profile } from '../../ui/settings';
import { createStore, type Store } from '../../ui/storage';

/** Prefix of every key the Arcade stores; the typing game's `bbtennis:v1:` keys are never read or written (spec §1.2, §6.4). */
export const ARCADE_STORAGE_PREFIX = 'bbtennis-arcade:v1:';

/** The Arcade's own settings (spec §6.4): volumes 0..1 and Reduce effects. */
export interface ArcadeSettings { volumes: Volumes; reduceEffects: boolean }

/** The last vs-CPU setup (spec §6.3): belt level 0..14 and the match options. */
export interface CpuSetup { level: number; format: FormatId; deuceRule: DeuceRule; surface: Surface; pace: PaceId }

export const DEFAULT_ARCADE_SETTINGS: ArcadeSettings = { volumes: { master: 0.8, music: 0.6, sfx: 0.8 }, reduceEffects: false };

/** A first vs-CPU setup: White belt, a Normal-pace tiebreak on a hard court. */
export const DEFAULT_CPU_SETUP: CpuSetup = { level: 0, format: 'tiebreak', deuceRule: 'advantage', surface: 'hard', pace: 'normal' };

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T>(values: readonly T[], v: unknown): v is T => values.includes(v as T);
const unit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

const FORMATS = valuesOf(FORMAT_CHOICES);
const DEUCE_RULES = valuesOf(DEUCE_CHOICES);
const SURFACES = valuesOf(SURFACE_CHOICES);
const PACES = valuesOf(PACE_CHOICES);

/** True for well-formed stored ArcadeSettings. */
export function isArcadeSettings(v: unknown): v is ArcadeSettings {
  if (!isObject(v) || !isObject(v['volumes'])) return false;
  const vol = v['volumes'];
  return unit(vol['master']) && unit(vol['music']) && unit(vol['sfx']) && typeof v['reduceEffects'] === 'boolean';
}

/** True for a well-formed stored CpuSetup: a whole belt level 0..14 and known options. */
export function isCpuSetup(v: unknown): v is CpuSetup {
  if (!isObject(v)) return false;
  const level = v['level'];
  return (
    Number.isInteger(level) &&
    (level as number) >= 0 &&
    (level as number) < BELTS.length &&
    oneOf(FORMATS, v['format']) &&
    oneOf(DEUCE_RULES, v['deuceRule']) &&
    oneOf(SURFACES, v['surface']) &&
    oneOf(PACES, v['pace'])
  );
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * The Arcade's saved data (spec §6.4): its own profile (name + look), settings and last CPU setup,
 * under `bbtennis-arcade:v1:`. Loaded once (missing, corrupt or invalid values fall back to the
 * defaults) and stored on every change. The first change that can't be stored calls
 * `onSaveFailed`, once; the change is kept for this visit.
 */
export class ArcadeStore {
  profile: Profile;
  settings: ArcadeSettings;
  cpuSetup: CpuSetup;
  private readonly store: Store = createStore(ARCADE_STORAGE_PREFIX);
  private saveFailed = false;

  constructor(private readonly onSaveFailed: () => void = () => {}) {
    this.profile = this.store.load('profile', clone(DEFAULT_PROFILE), isProfile);
    this.settings = this.store.load('settings', clone(DEFAULT_ARCADE_SETTINGS), isArcadeSettings);
    this.cpuSetup = this.store.load('cpuSetup', clone(DEFAULT_CPU_SETUP), isCpuSetup);
  }

  /** True when values can be stored in this browser mode. */
  storageOk(): boolean {
    return this.store.storageOk();
  }

  setProfile(profile: Profile): void {
    this.profile = clone(profile);
    this.save('profile', this.profile);
  }

  setSettings(patch: Partial<ArcadeSettings>): void {
    this.settings = { ...this.settings, ...clone(patch) };
    this.save('settings', this.settings);
  }

  setCpuSetup(patch: Partial<CpuSetup>): void {
    this.cpuSetup = { ...this.cpuSetup, ...clone(patch) };
    this.save('cpuSetup', this.cpuSetup);
  }

  private save(key: string, v: unknown): void {
    if (this.store.save(key, v) || this.saveFailed) return;
    this.saveFailed = true;
    this.onSaveFailed();
  }
}
