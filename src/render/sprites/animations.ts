/**
 * Player animation names and timing (spec §4.1). Directions are screen/court relative:
 * `runLeft`/`runRight` move toward screen-left/right, `runToward` runs forward toward the net and
 * `runAway` backpedals away from it (the player keeps facing the net).
 */
export type AnimName =
  | 'idle'
  | 'runLeft'
  | 'runRight'
  | 'runToward'
  | 'runAway'
  | 'forehand'
  | 'backhand'
  | 'serve'
  | 'stretch'
  | 'celebrate'
  | 'dejected';

/** Camera side of a player: `near` shows the back (near end), `far` shows the front (far end). */
export type View = 'near' | 'far';

/** Every animation, in sprite-sheet row order. */
export const ANIM_NAMES: readonly AnimName[] = [
  'idle',
  'runLeft',
  'runRight',
  'runToward',
  'runAway',
  'forehand',
  'backhand',
  'serve',
  'stretch',
  'celebrate',
  'dejected',
];

/** Both views, in sprite-sheet order. */
export const VIEWS: readonly View[] = ['near', 'far'];

/**
 * Frames per view, default frame time and looping per animation (spec §4.1: 34 frames per view).
 * One-shot swings hold their last frame; serve frames are toss, trophy, strike, follow-through.
 */
export const ANIMS: Record<AnimName, { frames: number; msPerFrame: number; loop: boolean }> = {
  idle: { frames: 2, msPerFrame: 500, loop: true },
  runLeft: { frames: 6, msPerFrame: 80, loop: true },
  runRight: { frames: 6, msPerFrame: 80, loop: true },
  runToward: { frames: 4, msPerFrame: 110, loop: true },
  runAway: { frames: 4, msPerFrame: 120, loop: true },
  forehand: { frames: 4, msPerFrame: 90, loop: false },
  backhand: { frames: 4, msPerFrame: 90, loop: false },
  serve: { frames: 4, msPerFrame: 250, loop: false },
  stretch: { frames: 2, msPerFrame: 150, loop: false },
  celebrate: { frames: 2, msPerFrame: 250, loop: true },
  dejected: { frames: 2, msPerFrame: 450, loop: true },
};

/** Sprite cell size and the feet anchor inside it (the ground point under the player). */
export const CELL = { w: 48, h: 48, anchorX: 24, anchorY: 46 } as const;

/** Frame number → frame index: looping animations wrap, one-shots hold their first/last frame. */
export function frameIndex(anim: AnimName, i: number): number {
  const { frames, loop } = ANIMS[anim];
  const n = Math.floor(i);
  if (loop) return ((n % frames) + frames) % frames;
  return Math.min(frames - 1, Math.max(0, n));
}
