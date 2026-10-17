import { BELTS, type BeltRank } from '../../core/belts';
import { forkSeed, intBelow, seedRng } from '../../core/rng';
import type { Look } from '../../core/types';
import { BELT_COLOR, RAMPS } from '../../render/palette';
import { HAIR_STYLES } from '../../render/sprites/parts';
import type { PlayerInfo } from '../core/types';

/** Base seed of the CPU looks; each belt level draws its own look from a fork of it. */
const LOOK_SEED = 0xa4c4de;
/** Shirt colours that are not belt colours, so the belt headband stands out. */
const SHIRTS: readonly number[] = RAMPS.cloth.map((_, i) => i).filter((i) => !Object.values(BELT_COLOR).includes(i));

/** "Brown Belt": the rank's belt colour in title case (every dan grade is "Black Belt"). */
function beltName(rank: BeltRank): string {
  return `${rank.belt[0]!.toUpperCase()}${rank.belt.slice(1)} Belt`;
}

/**
 * The CPU opponent at belt `level` (0..14, else White belt): named after its belt colour, in a
 * random look seeded by the level (the same opponent every visit) with its belt as the headband.
 */
export function arcadeCpuPlayer(level: number): PlayerInfo {
  const rank = BELTS[level] ?? BELTS[0]!;
  const rng = seedRng(forkSeed(LOOK_SEED, rank.level));
  const look: Look = {
    skin: intBelow(rng, RAMPS.skin.length),
    hairStyle: intBelow(rng, HAIR_STYLES.length),
    hair: intBelow(rng, RAMPS.hair.length),
    shirt: SHIRTS[intBelow(rng, SHIRTS.length)]!,
    shorts: intBelow(rng, RAMPS.cloth.length),
    headband: BELT_COLOR[rank.belt],
    racket: intBelow(rng, RAMPS.racket.length),
  };
  return { name: beltName(rank), look, kind: 'cpu', cpuLevel: rank.level };
}
