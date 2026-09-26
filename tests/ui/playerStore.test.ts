// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import type { MatchState, PlayerId } from '../../src/core/types';
import { BELT_COLOR } from '../../src/render/palette';
import { PlayerStore } from '../../src/ui/playerStore';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS } from '../../src/ui/settings';
import { STORAGE_PREFIX } from '../../src/ui/storage';

const WHITE = CPU_LEVELS.findIndex((l) => l.belt === 'white' && l.stripes === 0);
const stored = (key: string): unknown => JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + key) ?? 'null');

/** A finished vs-CPU match against level 0 won by `winner` (the player is 0). */
function finished(winner: PlayerId): MatchState {
  const look = DEFAULT_PROFILE.look;
  const s = new Engine({
    config: { format: 'tiebreak', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: [
      { name: 'Alex', look, kind: 'human', cpuLevel: null },
      { name: 'Mika', look, kind: 'cpu', cpuLevel: 0 },
    ],
    seed: 1,
  }).state;
  s.status = 'over';
  s.winner = winner;
  return s;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlayerStore: first launch and the Training offer (spec §3.12)', () => {
  it('a first launch (no stored settings) starts from the defaults and offers Training', () => {
    const store = new PlayerStore();
    expect(store.firstLaunch).toBe(true);
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(store.trainingOffered()).toBe(true);
  });

  it('a later launch (settings stored) offers nothing and keeps the stored settings', () => {
    new PlayerStore().setSettings({ pace: 'fast' });
    const store = new PlayerStore();
    expect(store.firstLaunch).toBe(false);
    expect(store.settings.pace).toBe('fast');
    expect(store.trainingOffered()).toBe(false);
  });

  it('broken stored settings count as a first launch', () => {
    window.localStorage.setItem(`${STORAGE_PREFIX}settings`, '{"pace":"warp"}');
    expect(new PlayerStore().firstLaunch).toBe(true);
  });

  it('LATER puts the offer off for good, on this visit and the next', () => {
    const store = new PlayerStore();
    store.dismissTrainingOffer();
    expect(store.trainingOffered()).toBe(false);
    expect(stored('trainingOfferDismissed')).toBe(true);
    expect(new PlayerStore().trainingOffered()).toBe(false);
  });

  it('finishing Training ends the offer', () => {
    const store = new PlayerStore();
    store.setSettings({ trainingDone: true });
    expect(store.trainingOffered()).toBe(false);
  });

  it('with storage blocked, every launch is a first one and the offer can still be put off for the visit', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const store = new PlayerStore();
    expect(store.trainingOffered()).toBe(true);
    store.dismissTrainingOffer();
    expect(store.trainingOffered()).toBe(false);
  });
});

describe('PlayerStore: stored data', () => {
  it('stores each settings change and profile at once', () => {
    const store = new PlayerStore();
    store.setSettings({ deuceRule: 'golden' });
    store.setProfile({ ...DEFAULT_PROFILE, name: 'Zoe' }, false);
    expect(stored('settings')).toMatchObject({ deuceRule: 'golden' });
    expect(stored('profile')).toMatchObject({ name: 'Zoe' });
    expect(new PlayerStore().profile.name).toBe('Zoe');
  });

  it('records a finished vs-CPU match: career, matches played and the earned belt as headband', () => {
    const store = new PlayerStore();
    expect(store.recordCpuMatch(WHITE, finished(0))).toBe('white');
    const again = new PlayerStore();
    expect(again.career.perLevel[WHITE]).toEqual({ played: 1, won: 1 });
    expect(again.career.earned).toEqual(['white']);
    expect(again.settings.matchesPlayed).toBe(1);
    expect(again.profile.look.headband).toBe(BELT_COLOR.white);
  });

  it('keeps a headband the player chose in Customize, on later visits too', () => {
    new PlayerStore().setProfile({ ...DEFAULT_PROFILE, look: { ...DEFAULT_PROFILE.look, headband: 9 } }, true);
    const store = new PlayerStore();
    expect(store.recordCpuMatch(WHITE, finished(0))).toBe('white');
    expect(store.profile.look.headband).toBe(9);
  });
});
