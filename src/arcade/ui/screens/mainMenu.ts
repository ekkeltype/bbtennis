import { RAMPS } from '../../../render/palette';
import { button, fullscreenButton, swatch } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeContext } from '../context';
import { arcadeLogoCanvas } from '../logo';

/**
 * Main menu (spec §6.3, online spec §5): Play vs CPU, Play Online (Host Game / Join Game), Customize,
 * Options, How to Play and Fullscreen in the opaque left column (logo above, the player's name and
 * shirt below), the attract demo to the right.
 */
export function mainMenuScreen(ctx: Pick<ArcadeContext, 'router' | 'profile' | 'toggleFullscreen'>): ScreenFactory {
  return () => {
    const go = (name: string) => () => ctx.router.go(name);
    const host = button('HOST GAME', go('host'), 'sub');
    const join = button('JOIN GAME', go('join'), 'sub');
    const online = h('div', { class: 'submenu', hidden: true }, host, join);
    const onlineBtn = button('PLAY ONLINE', () => {
      online.hidden = !online.hidden;
      onlineBtn.setAttribute('aria-expanded', String(!online.hidden));
      if (!online.hidden) host.focus({ preventScroll: true });
    });
    onlineBtn.setAttribute('aria-expanded', 'false');
    const menu = h(
      'nav',
      { class: 'menu' },
      button('PLAY VS CPU', go('cpuSetup')),
      onlineBtn,
      online,
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
    const el = h('div', { class: 'screen main-menu' }, h('div', { class: 'side' }, h('div', { class: 'logo-wrap small' }, arcadeLogoCanvas()), h('section', { class: 'panel menu-panel' }, menu), tag));
    return { el };
  };
}
