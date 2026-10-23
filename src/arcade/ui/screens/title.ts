import type { ScreenFactory } from '../../../ui/router';
import { titleScreen as sharedTitleScreen } from '../../../ui/screens/title';
import type { ArcadeContext } from '../context';
import { arcadeLogoCanvas } from '../logo';

/** Title (spec §6.3): the shared title screen, its logo stamped ARCADE, over the attract demo; PRESS ENTER opens the main menu. */
export function titleScreen(ctx: Pick<ArcadeContext, 'router' | 'toggleFullscreen'>): ScreenFactory {
  return sharedTitleScreen(ctx, arcadeLogoCanvas);
}
