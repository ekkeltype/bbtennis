import { BELT_COLOR, RAMPS } from '../../render/palette';
import { button, fullscreenButton, swatch } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { logoCanvas } from '../logo';
import type { ScreenFactory } from '../router';
import { highestBelt } from '../settings';

/** The player's card under the menu: name, headband/belt swatch and highest belt. */
function playerTag(ctx: UiContext): HTMLElement {
  const belt = highestBelt(ctx.career);
  const ramp = RAMPS.cloth[belt === null ? ctx.profile.look.shirt : BELT_COLOR[belt]];
  const best = Math.round(ctx.career.bestWpm);
  return h(
    'div',
    { class: 'player-tag' },
    swatch(ramp),
    h(
      'span',
      { class: 'lines' },
      h('span', { class: 'who' }, ctx.profile.name.toUpperCase()),
      h('span', { class: 'what' }, belt === null ? 'NO BELT YET' : `${belt.toUpperCase()} BELT`, best > 0 ? ` · BEST ${best} WPM` : ''),
    ),
  );
}

/**
 * Main menu (spec §4.6): Training first until completed once, Play vs CPU, Play Online (Host / Join),
 * Customize, Options, How to Play, Fullscreen. Runs over the attract demo.
 */
export function mainMenuScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const go = (name: string) => () => ctx.router.go(name);
    const training = button('TRAINING', () => ctx.startTraining());
    const host = button('HOST GAME', go('host'), 'sub');
    const join = button('JOIN GAME', go('join'), 'sub');
    const online = h('div', { class: 'submenu', hidden: true }, host, join);
    const onlineBtn = button('PLAY ONLINE', () => {
      online.hidden = !online.hidden;
      onlineBtn.setAttribute('aria-expanded', String(!online.hidden));
      if (!online.hidden) host.focus({ preventScroll: true });
    });
    onlineBtn.setAttribute('aria-expanded', 'false');
    const first = !ctx.settings.trainingDone;
    const menu = h(
      'nav',
      { class: 'menu' },
      first ? training : null,
      button('PLAY VS CPU', go('cpuSetup')),
      onlineBtn,
      online,
      button('CUSTOMIZE', go('customize')),
      button('OPTIONS', go('options')),
      button('HOW TO PLAY', go('howTo')),
      first ? null : training,
      fullscreenButton(ctx),
    );
    const el = h(
      'div',
      { class: 'screen main-menu' },
      h('div', { class: 'side' }, h('div', { class: 'logo-wrap small' }, logoCanvas()), h('section', { class: 'panel menu-panel' }, menu), playerTag(ctx)),
    );
    return { el };
  };
}
