import { h } from '../../../ui/dom';
import { logoCanvas } from '../../../ui/logo';
import type { ScreenFactory } from '../../../ui/router';
import { titleScreen as sharedTitleScreen } from '../../../ui/screens/title';
import type { ArcadeContext } from '../context';

/** The logo with the "ARCADE" line under it (title and main menu). */
export function arcadeLogo(small = false): HTMLElement {
  return h('div', { class: `logo-wrap arcade-logo${small ? ' small' : ''}` }, logoCanvas(), h('p', { class: 'arcade-word' }, 'ARCADE'));
}

/** Title (spec §6.3): the shared title screen with "BLACK BELT TENNIS ARCADE" over the attract demo; PRESS ENTER opens the main menu. */
export function titleScreen(ctx: Pick<ArcadeContext, 'router' | 'toggleFullscreen'>): ScreenFactory {
  return sharedTitleScreen(ctx, () => arcadeLogo());
}
