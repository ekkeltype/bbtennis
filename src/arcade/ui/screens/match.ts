import type { ScreenFactory } from '../../../ui/router';
import { playScreen } from '../../../ui/screens/match';
import type { ArcadeContext } from '../context';

/**
 * The screen over a match being played (spec §6.3): transparent, the canvas draws the match; the
 * shared play screen's click target on the HUD's pause icon pauses, any other click focuses the
 * game. Keys go to the app's HeldKeys, not here.
 */
export function matchScreen(ctx: Pick<ArcadeContext, 'pauseMatch' | 'focusGame'>): ScreenFactory {
  return playScreen(ctx, 'cpu');
}
