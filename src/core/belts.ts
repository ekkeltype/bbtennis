/** One of the 15 belt ranks as shown to the player: belt with 0–2 stripes (or dan grade) and label. */
export interface BeltRank {
  level: number;
  belt: 'white' | 'yellow' | 'green' | 'brown' | 'black';
  stripes: 0 | 1 | 2;
  dan: 0 | 2 | 3;
  label: string;
}

type Rank = Pick<BeltRank, 'belt' | 'stripes' | 'dan'>;

/** Belt, stripes and dan of each level (index = level). */
const RANKS: readonly Rank[] = [
  { belt: 'white', stripes: 0, dan: 0 },
  { belt: 'white', stripes: 1, dan: 0 },
  { belt: 'white', stripes: 2, dan: 0 },
  { belt: 'yellow', stripes: 0, dan: 0 },
  { belt: 'yellow', stripes: 1, dan: 0 },
  { belt: 'yellow', stripes: 2, dan: 0 },
  { belt: 'green', stripes: 0, dan: 0 },
  { belt: 'green', stripes: 1, dan: 0 },
  { belt: 'green', stripes: 2, dan: 0 },
  { belt: 'brown', stripes: 0, dan: 0 },
  { belt: 'brown', stripes: 1, dan: 0 },
  { belt: 'brown', stripes: 2, dan: 0 },
  { belt: 'black', stripes: 0, dan: 0 },
  { belt: 'black', stripes: 0, dan: 2 },
  { belt: 'black', stripes: 0, dan: 3 },
];

const DAN_ORDINALS: Record<2 | 3, string> = { 2: '2ND', 3: '3RD' };

function rankLabel(r: Rank): string {
  const belt = `${r.belt.toUpperCase()} BELT`;
  if (r.dan !== 0) return `${belt} ${DAN_ORDINALS[r.dan]} DAN`;
  return r.stripes === 0 ? belt : `${belt} ${'★'.repeat(r.stripes)}`;
}

/** The 15 ranks, easiest first (index = level); labels like 'GREEN BELT ★★' or 'BLACK BELT 2ND DAN'. */
export const BELTS: readonly BeltRank[] = RANKS.map((rank, level) => ({ level, ...rank, label: rankLabel(rank) }));

/** True for a level that is a milestone row (a belt with no stripes, or a dan grade). */
export function isMilestoneBelt(level: number): boolean {
  return BELTS[level]?.stripes === 0;
}
