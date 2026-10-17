import { RAMPS } from '../../../render/palette';
import { button, fullscreenButton, swatch } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeContext } from '../context';
import { arcadeLogo } from './title';

/**
 * Main menu (spec §6.3): Play vs CPU, Customize, Options, How to Play and Fullscreen in the opaque
 * left column (logo above, the player's name and shirt below), the attract demo to the right.
 */
export function mainMenuScreen(ctx: Pick<ArcadeContext, 'router' | 'profile' | 'toggleFullscreen'>): ScreenFactory {
  return () => {
    const go = (name: string) => () => ctx.router.go(name);
    const menu = h(
      'nav',
      { class: 'menu' },
      button('PLAY VS CPU', go('cpuSetup')),
      button('CUSTOMIZE', go('customize')),
      button('OPTIONS', go('options')),
      button('HOW TO PLAY', go('howTo')),
      fullscreenButton(ctx),
    );
    const tag = h(
      'div',
      { class: 'player-tag' },
      swatch(RAMPS.cloth[ctx.profile.look.shirt]),
      h('span', { class: 'lines' }, h('span', { class: 'who' }, ctx.profile.name.toUpperCase())),
    );
    const el = h('div', { class: 'screen main-menu' }, h('div', { class: 'side' }, arcadeLogo(true), h('section', { class: 'panel menu-panel' }, menu), tag));
    return { el };
  };
}
