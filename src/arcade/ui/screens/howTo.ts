import { button, panel } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeContext } from '../context';

/**
 * The controls of spec §4.1 (and Tab, which also pauses, §6.3): each action's keys in the two
 * layouts. `either`: the keys are alternatives (shown "ESC / TAB"), not a set like W A S D.
 */
const CONTROLS: readonly { action: string; keys: readonly [readonly string[], readonly string[]]; either?: true }[] = [
  { action: 'MOVE', keys: [['W', 'A', 'S', 'D'], ['ARROWS']] },
  { action: 'TOPSPIN', keys: [['J'], ['Z']] },
  { action: 'SLICE', keys: [['K'], ['X']] },
  { action: 'LOB', keys: [['L'], ['C']] },
  { action: 'PAUSE', keys: [['ESC', 'TAB'], ['ESC', 'TAB']], either: true },
];

/** The rules in short paragraphs (spec §4.3–§4.8, online spec §5): heading and text. */
const RULES: Readonly<Record<'swing' | 'aim' | 'serve' | 'shots' | 'online', { title: string; text: string }>> = {
  swing: {
    title: 'SWING',
    text:
      'Get into position, then press a shot key: your feet plant, a few small steps take you to the ball and you swing by yourself. ' +
      'While planted, the direction keys only aim. The bar fills in 0.5 s, and contact just after it is full is PERFECT: harder and more accurate. ' +
      'A late press is weaker and wilder. A press before the ball is struck waits for it.',
  },
  aim: {
    title: 'AIM',
    text: 'Hold a direction as you hit: left or right aims at that sideline, up aims deep, down aims short. Hold none to play safe, to the middle.',
  },
  serve: {
    title: 'SERVE',
    text:
      'Press a shot key to toss and again to serve, best just after the top of the toss. ' +
      'The topspin key serves flat, the slice key slices, the lob key kicks. Left or right aims wide or down the T.',
  },
  shots: {
    title: 'SHOTS',
    text:
      'Topspin: fast and dipping. Slice: low and skidding; played short, a drop shot. Lob: high and deep, over a player at the net. ' +
      'A high ball near the net is a smash, whatever the key.',
  },
  online: {
    title: 'ONLINE',
    text: 'Host a game and send a friend its code or invite link. You both play from the bottom of your own screen, and the match never pauses.',
  },
};

/** A cell of keycaps; alternatives get a " / " between them. */
function caps(keys: readonly string[], either = false): HTMLElement {
  return h('td', {}, ...keys.flatMap((k, i) => (either && i > 0 ? [h('span', { class: 'or' }, ' / '), h('kbd', {}, k)] : [h('kbd', {}, k)])));
}

function controlsTable(): HTMLElement {
  return h(
    'table',
    { class: 'controls' },
    h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'LEFT + RIGHT HAND'), h('th', {}, 'ARROWS + LETTERS'))),
    h('tbody', {}, ...CONTROLS.map((c) => h('tr', {}, h('th', {}, c.action), caps(c.keys[0], c.either), caps(c.keys[1], c.either)))),
  );
}

const rule = (r: { title: string; text: string }): HTMLElement => h('p', { class: 'rule' }, h('span', { class: 'rule-title' }, r.title), ' ', r.text);

/** How to Play (spec §6.3): the controls table, then the swing timing, aim, serve, shot types and online play. */
export function howToScreen(ctx: Pick<ArcadeContext, 'router'>): ScreenFactory {
  return () => {
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'HOW TO PLAY',
        'how-to arcade-how-to',
        h(
          'div',
          { class: 'how-body' },
          h('div', { class: 'col' }, controlsTable(), rule(RULES.serve), rule(RULES.online)),
          h('div', { class: 'col' }, rule(RULES.swing), rule(RULES.aim), rule(RULES.shots)),
        ),
        h('div', { class: 'actions' }, button('BACK', () => ctx.router.back(), 'primary')),
      ),
    );
    return { el };
  };
}
