// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCADE_STORAGE_PREFIX,
  ArcadeStore,
  DEFAULT_ARCADE_SETTINGS,
  DEFAULT_CPU_SETUP,
  type ArcadeSettings,
  type CpuSetup,
} from '../../../src/arcade/ui/store';
import { DEFAULT_PROFILE, type Profile } from '../../../src/ui/settings';

const PROFILE: Profile = { name: 'ARCADER', look: { skin: 2, hairStyle: 3, hair: 4, shirt: 9, shorts: 7, headband: 5, racket: 1 } };
const SETTINGS: ArcadeSettings = { volumes: { master: 0.5, music: 0.2, sfx: 1 }, reduceEffects: true };
const SETUP: CpuSetup = { level: 11, format: 'bo3', deuceRule: 'golden', surface: 'grass', pace: 'lightning' };

/** Every localStorage key and value, as a plain object. */
function snapshot(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k);
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ArcadeStore', () => {
  it('stores under the bbtennis-arcade:v1: prefix', () => {
    expect(ARCADE_STORAGE_PREFIX).toBe('bbtennis-arcade:v1:');
    const store = new ArcadeStore();
    store.setProfile(PROFILE);
    store.setSettings(SETTINGS);
    store.setCpuSetup(SETUP);
    expect(Object.keys(snapshot()).sort()).toEqual([
      'bbtennis-arcade:v1:cpuSetup',
      'bbtennis-arcade:v1:profile',
      'bbtennis-arcade:v1:settings',
    ]);
  });

  it('round-trips the profile, settings and CPU setup through a new store', () => {
    const a = new ArcadeStore();
    a.setProfile(PROFILE);
    a.setSettings({ reduceEffects: true });
    a.setSettings({ volumes: SETTINGS.volumes });
    a.setCpuSetup({ level: 11, format: 'bo3' });
    a.setCpuSetup({ deuceRule: 'golden', surface: 'grass', pace: 'lightning' });
    const b = new ArcadeStore();
    expect(b.profile).toEqual(PROFILE);
    expect(b.settings).toEqual(SETTINGS);
    expect(b.cpuSetup).toEqual(SETUP);
  });

  it('starts from the defaults when nothing is stored', () => {
    const s = new ArcadeStore();
    expect(s.profile).toEqual(DEFAULT_PROFILE);
    expect(s.settings).toEqual(DEFAULT_ARCADE_SETTINGS);
    expect(s.cpuSetup).toEqual(DEFAULT_CPU_SETUP);
  });

  it('falls back to the defaults for corrupt or invalid data', () => {
    localStorage.setItem('bbtennis-arcade:v1:profile', JSON.stringify({ name: 'X', look: { ...PROFILE.look, skin: 99 } }));
    localStorage.setItem('bbtennis-arcade:v1:settings', '{not json');
    localStorage.setItem('bbtennis-arcade:v1:cpuSetup', JSON.stringify({ ...SETUP, level: 15 }));
    const s = new ArcadeStore();
    expect(s.profile).toEqual(DEFAULT_PROFILE);
    expect(s.settings).toEqual(DEFAULT_ARCADE_SETTINGS);
    expect(s.cpuSetup).toEqual(DEFAULT_CPU_SETUP);
  });

  it.each([
    ['a volume above 1', { volumes: { master: 1.5, music: 0.5, sfx: 0.5 }, reduceEffects: false }],
    ['a missing volume', { volumes: { master: 0.5, music: 0.5 }, reduceEffects: false }],
    ['a non-boolean reduceEffects', { volumes: SETTINGS.volumes, reduceEffects: 'yes' }],
  ])('rejects settings with %s', (_, bad) => {
    localStorage.setItem('bbtennis-arcade:v1:settings', JSON.stringify(bad));
    expect(new ArcadeStore().settings).toEqual(DEFAULT_ARCADE_SETTINGS);
  });

  it.each([
    ['a fractional level', { ...SETUP, level: 2.5 }],
    ['an unknown format', { ...SETUP, format: 'marathon' }],
    ['an unknown deuce rule', { ...SETUP, deuceRule: 'sudden' }],
    ['an unknown surface', { ...SETUP, surface: 'ice' }],
    ['an unknown pace', { ...SETUP, pace: 'warp' }],
  ])('rejects a CPU setup with %s', (_, bad) => {
    localStorage.setItem('bbtennis-arcade:v1:cpuSetup', JSON.stringify(bad));
    expect(new ArcadeStore().cpuSetup).toEqual(DEFAULT_CPU_SETUP);
  });

  it("neither reads nor writes the typing game's bbtennis:v1: keys", () => {
    const typing = {
      'bbtennis:v1:profile': JSON.stringify({ name: 'TYPIST', look: PROFILE.look }),
      'bbtennis:v1:settings': JSON.stringify({ volumes: { master: 0.1, music: 0.1, sfx: 0.1 }, reduceEffects: true }),
      'bbtennis:v1:cpuSetup': JSON.stringify(SETUP),
    };
    for (const [k, v] of Object.entries(typing)) localStorage.setItem(k, v);
    const s = new ArcadeStore();
    expect(s.profile).toEqual(DEFAULT_PROFILE);
    expect(s.settings).toEqual(DEFAULT_ARCADE_SETTINGS);
    expect(s.cpuSetup).toEqual(DEFAULT_CPU_SETUP);
    s.setProfile(PROFILE);
    s.setSettings(SETTINGS);
    s.setCpuSetup({ level: 3 });
    const after = snapshot();
    for (const [k, v] of Object.entries(typing)) expect(after[k]).toBe(v);
    const added = Object.keys(after).filter((k) => !(k in typing));
    expect(added.length).toBe(3);
    for (const k of added) expect(k.startsWith('bbtennis-arcade:v1:')).toBe(true);
  });

  it('keeps changes for the visit and reports the first failed save once', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const failed = vi.fn();
    const s = new ArcadeStore(failed);
    s.setSettings({ reduceEffects: true });
    s.setCpuSetup({ level: 4 });
    expect(s.settings.reduceEffects).toBe(true);
    expect(s.cpuSetup.level).toBe(4);
    expect(failed).toHaveBeenCalledOnce();
  });

  it('hands out copies, so a caller cannot change what is stored', () => {
    const s = new ArcadeStore();
    const patch = { volumes: { master: 0.3, music: 0.3, sfx: 0.3 } };
    s.setSettings(patch);
    patch.volumes.master = 0.9;
    expect(s.settings.volumes.master).toBe(0.3);
  });
});
