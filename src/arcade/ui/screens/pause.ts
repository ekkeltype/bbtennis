import type { ScreenFactory } from '../../../ui/router';
import { pauseScreen as sharedPauseScreen } from '../../../ui/screens/pause';
import type { ArcadeContext } from '../context';

/**
 * The pause menu (spec §6.3): the shared one for a local match, i.e. Resume / Restart / Quit and
 * Fullscreen; Esc resumes. A vs-CPU match never forfeits.
 */
export function pauseScreen(ctx: Pick<ArcadeContext, 'resumeMatch' | 'restartMatch' | 'quitMatch' | 'toggleFullscreen'>): ScreenFactory {
  const shared = sharedPauseScreen({
    resumeMatch: () => ctx.resumeMatch(),
    restartMatch: () => ctx.restartMatch(),
    quitMatch: () => ctx.quitMatch(),
    toggleFullscreen: () => ctx.toggleFullscreen(),
    forfeitMatch: () => {},
  });
  return () => shared({ kind: 'cpu' });
}
