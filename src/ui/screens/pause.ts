import { button, fullscreenButton, panel } from '../controls';
import type { PauseParams, UiContext } from '../context';
import { h } from '../dom';
import type { ScreenFactory } from '../router';

/**
 * The in-match menu (spec §4.6): a local match (vs CPU, Training) is paused behind it and offers
 * Resume / Restart / Quit; online play does not pause and offers Resume / Forfeit. Esc resumes.
 */
export function pauseScreen(ctx: UiContext): ScreenFactory {
  return (params) => {
    const { kind } = params as PauseParams;
    const actions =
      kind === 'online'
        ? [button('FORFEIT', () => ctx.forfeitMatch())]
        : [button('RESTART', () => ctx.restartMatch()), button('QUIT', () => ctx.quitMatch())];
    const el = h(
      'div',
      { class: 'screen pause' },
      panel(
        kind === 'online' ? 'MENU' : 'PAUSED',
        'pause-panel',
        h('nav', { class: 'menu' }, button('RESUME', () => ctx.resumeMatch()), ...actions, fullscreenButton(ctx)),
        kind === 'online' ? h('p', { class: 'note' }, 'THE MATCH GOES ON WHILE THIS MENU IS OPEN') : null,
      ),
    );
    return { el, onBack: () => ctx.resumeMatch() };
  };
}
