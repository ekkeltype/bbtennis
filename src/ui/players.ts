import { CPU_LEVELS } from '../core/cpu';
import type { Look, PlayerInfo, Profile } from '../core/types';
import { BELT_COLOR } from '../render/palette';

/** One opponent name per CPU level, easiest first; every name fits the bitmap font's name set. */
const CPU_NAMES: readonly string[] = [
  'Tomo', 'Pip', 'Rosa', 'Kai', 'Lena', 'Omar', 'Mika', 'Ivo',
  'Suki', 'Bruno', 'Nadia', 'Kenji', 'Sensei Ra', 'Master Lin', 'Grandmaster',
];
/** Shirt ramps that are not belt colours, so a CPU's belt headband stands out. */
const CPU_SHIRTS: readonly number[] = [5, 6, 7, 8, 9, 10, 11];
const CPU_SHORTS: readonly number[] = [0, 4, 7, 3];
/** The attract demo's opponents come from Green belt (level 6) to Black belt (level 12) (spec §4.6). */
const ATTRACT_LEVELS: readonly number[] = [6, 7, 8, 9, 10, 11, 12];

const pick = <T>(list: readonly T[], i: number): T => list[((i % list.length) + list.length) % list.length] as T;

/** The CPU opponent of a level: its own name and look, wearing its belt as a headband (spec §3.8). */
export function cpuPlayer(level: number): PlayerInfo {
  const info = CPU_LEVELS[level] ?? CPU_LEVELS[0]!;
  const look: Look = {
    skin: (level * 5) % 6,
    hairStyle: (level * 2) % 5,
    hair: (level * 3) % 8,
    shirt: pick(CPU_SHIRTS, level),
    shorts: pick(CPU_SHORTS, level),
    headband: BELT_COLOR[info.belt],
    racket: level % 6,
  };
  return { name: pick(CPU_NAMES, info.level), look, kind: 'cpu', cpuLevel: info.level };
}

/** The local player in a match, with a copy of the profile's look. */
export function humanPlayer(profile: Profile): PlayerInfo {
  return { name: profile.name, look: { ...profile.look }, kind: 'human', cpuLevel: null };
}

/** Two different CPU levels from Green to Black for the attract demo, drawn with `random` (0 ≤ r < 1). */
export function attractPlayers(random: () => number = Math.random): [PlayerInfo, PlayerInfo] {
  const index = (n: number): number => Math.min(n - 1, Math.floor(random() * n));
  const a = pick(ATTRACT_LEVELS, index(ATTRACT_LEVELS.length));
  const rest = ATTRACT_LEVELS.filter((l) => l !== a);
  const b = pick(rest, index(rest.length));
  return [cpuPlayer(a), cpuPlayer(b)];
}
