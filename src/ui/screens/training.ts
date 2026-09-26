import type { PlayerInfo, Profile } from '../../core/types';
import type { Scheduler } from '../../game/clock';
import { LocalSession } from '../../game/localSession';
import { trainingOptions } from '../../game/training';
import type { UiContext } from '../context';
import type { ScreenFactory } from '../router';
import { cpuPlayer, humanPlayer } from '../players';
import { playScreen } from './match';

/** The Training coach's name and White-belt look. */
const COACH: PlayerInfo = { ...cpuPlayer(0), name: 'Coach' };

/**
 * A Training session (spec §3.12): the player (0) against the scripted White-belt coach, serving
 * first, on a Relaxed tiebreak with the lessons' coach text in the HUD (it comes via the ViewModel).
 */
export function createTrainingSession(profile: Profile, seed: number, scheduler: Scheduler): LocalSession {
  return new LocalSession(trainingOptions({ players: [humanPlayer(profile), COACH], seed, scheduler }));
}

/** The screen over a Training session: the play screen (coach text is drawn in the HUD by the renderer). */
export function trainingScreen(ctx: UiContext): ScreenFactory {
  return playScreen(ctx, 'training');
}
