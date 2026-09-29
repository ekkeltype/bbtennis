import { button, panel } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { illustration, ILLUSTRATIONS } from '../illustrations';
import type { ScreenFactory } from '../router';

/** Heading and text of each illustrated rule, in the order of `ILLUSTRATIONS`. */
const RULES: Record<string, { title: string; text: string }> = {
  serve: { title: '1. SERVE', text: 'Press SPACE to toss, then type one of the three words before the ball drops.' },
  choose: { title: '2. PICK A SHOT', text: 'The first letter picks the shot. Harder words aim wider: riskier, and harder to return.' },
  chase: { title: '3. CHASE, THEN CHOOSE', text: 'Type their word to run to the ball, as soon as they pick it. Then pick your shot.' },
  typos: { title: '4. TYPOS COST YOU', text: "A wrong key doesn't advance and makes the shot riskier: out, or into the net." },
};

/** The power meter rule (power-meter spec §6), under the illustrated rules. */
export const POWER_TEXT =
  'POWER METER: flawless serves and shots fill its four segments. When full you also get an INSANE ' +
  'word: a near-winner, but a typo sends it out. A wrong key or losing a point empties it.';

/** How to Play (spec §4.6): the rules illustrated with the real plate art, the controls, and the OFL font credits. */
export function howToScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const cards = ILLUSTRATIONS.map(({ id, paint }) => {
      const rule = RULES[id]!;
      return h('article', { class: 'card' }, h('h3', {}, rule.title), illustration(paint, ctx.profile.look), h('p', {}, rule.text));
    });
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'HOW TO PLAY',
        'how-to',
        h('div', { class: 'cards' }, ...cards),
        h('p', { class: 'power' }, POWER_TEXT),
        h(
          'p',
          { class: 'keys' },
          h('kbd', {}, 'SPACE'),
          ' toss   ',
          h('kbd', {}, 'A-Z'),
          ' type   ',
          h('kbd', {}, 'ESC'),
          ' / ',
          h('kbd', {}, 'TAB'),
          ' pause   Faster typing = faster shots.',
        ),
        h(
          'p',
          { class: 'credits' },
          'Fonts: Press Start 2P, copyright 2012 The Press Start 2P Project Authors; Pixelify Sans, copyright 2021 The Pixelify Sans Project Authors. ',
          'Both under the SIL Open Font License 1.1 (licence texts in the licenses folder).',
        ),
        h('div', { class: 'actions' }, button('BACK', () => ctx.router.back(), 'primary')),
      ),
    );
    return { el };
  };
}
