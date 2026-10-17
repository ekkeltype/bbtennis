import type { CallKind, PlayerId, PointReason } from '../core/types';
import { clamp } from '../core/util';
import type { PlayOptions, SfxName } from './engine';

/** Gain of the applause for the opponent's ace or winner. */
export const POLITE_APPLAUSE_GAIN = 0.5;

/** Stereo pan for a court x as the viewer sees it (end-1 viewers see the court rotated by 180°); `widthM` pans fully to one side. */
export function panFor(x: number, viewer: PlayerId | 'spectator', widthM: number): number {
  return clamp((viewer === 1 ? -x : x) / widthM, -1, 1);
}

/** The calls the umpire says, most important first: when a frame carries several, only the top one is said. */
export const SPOKEN_CALLS: readonly { call: CallKind; words: string }[] = [
  { call: 'doubleFault', words: 'Double fault' },
  { call: 'timeViolation', words: 'Time violation' },
  { call: 'fault', words: 'Fault' },
  { call: 'ballDropped', words: 'Fault' },
  { call: 'out', words: 'Out' },
];

/** Index of `call` in `list` (lower = more important), or Infinity for a call the umpire leaves unsaid. */
export function callRank(call: CallKind, list: readonly { call: CallKind }[] = SPOKEN_CALLS): number {
  const i = list.findIndex((c) => c.call === call);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

/** The home crowd: cheers the viewer's points, claps politely for an opponent's ace or winner, otherwise groans. */
export function pointReaction(
  winner: PlayerId,
  reason: PointReason,
  viewer: PlayerId | 'spectator',
): { name: SfxName; opts?: PlayOptions } {
  if (viewer === 'spectator' || winner === viewer) return { name: 'applause' };
  if (reason === 'ace' || reason === 'winner') return { name: 'applause', opts: { gain: POLITE_APPLAUSE_GAIN } };
  return { name: 'ooh' };
}
