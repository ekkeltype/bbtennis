import type { PauseParams } from '../../../ui/context';
import type { ScreenFactory } from '../../../ui/router';
import { pauseScreen as sharedPauseScreen } from '../../../ui/screens/pause';
import type { ArcadeContext } from '../context';

/**
 * The in-match menu (spec §6.3, online spec §5): the shared one. A local match is paused behind it:
 * Resume / Restart / Quit and Fullscreen, Esc resumes; a vs-CPU match never forfeits. Online (params
 * `{ kind: 'online' }`) the match goes on: Resume / Forfeit and Fullscreen.
 */
export function pauseScreen(
  ctx: Pick<ArcadeContext, 'resumeMatch' | 'restartMatch' | 'quitMatch' | 'forfeitMatch' | 'toggleFullscreen'>,
): ScreenFactory {
  const shared = sharedPauseScreen({
    resumeMatch: () => ctx.resumeMatch(),
    restartMatch: () => ctx.restartMatch(),
    quitMatch: () => ctx.quitMatch(),
    toggleFullscreen: () => ctx.toggleFullscreen(),
    forfeitMatch: () => ctx.forfeitMatch(),
  });
  return (params) => shared({ kind: (params as PauseParams | undefined)?.kind === 'online' ? 'online' : 'cpu' });
}
