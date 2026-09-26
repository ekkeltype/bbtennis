import { PAUSE_ICON_RECT } from '../../render/renderer';
import type { MatchKind, UiContext } from '../context';
import { h } from '../dom';
import type { ScreenFactory } from '../router';

/**
 * The screen over a match being played: no menu, only a click target on the HUD's pause icon (in
 * game pixels, so it follows `--u`). Any other click puts the keyboard focus back on the game (and
 * clears the online "click to focus" overlay). Keys go to the match's keyboard capture, not here.
 */
export function playScreen(ctx: UiContext, kind: MatchKind): ScreenFactory {
  return () => {
    const r = PAUSE_ICON_RECT;
    const pause = h('button', {
      type: 'button',
      class: 'pause-hit',
      tabindex: -1,
      'aria-label': 'Pause',
      style: { '--x': String(r.x), '--y': String(r.y), '--w': String(r.w), '--h': String(r.h) },
    });
    pause.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.pauseMatch();
    });
    const el = h('div', { class: `screen play ${kind}` }, pause);
    el.addEventListener('click', () => ctx.focusGame());
    return { el, onBack: () => ctx.pauseMatch() };
  };
}
