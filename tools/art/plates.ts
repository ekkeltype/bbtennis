import { serverSpot } from '../../src/core/court';
import type { WordOption } from '../../src/core/types';
import { BANDS, layoutServeFar, layoutServeNear, plateWidth } from '../../src/render/layout';
import { BELT_COLOR, PAL, RAMPS } from '../../src/render/palette';
import { drawPlate, nameChipBox, type PlateDraw } from '../../src/render/plates';
import { project } from '../../src/render/projection';
import { addFigure, addHeading, addRow, addSection, newCanvas, scaled } from './dom';

const K = 4;
/** One word per tier at lengths 3, 7 and 8 (tiers follow length, power-meter spec §3), with ascenders and descenders. */
const WORDS: readonly WordOption[] = [
  { word: 'jog', len: 3, tier: 'easy' },
  { word: 'jumping', len: 7, tier: 'medium' },
  { word: 'skipping', len: 8, tier: 'hard' },
];
/** The insane sample: 14 letters, the widest common plate. */
const INSANE_WORDS: readonly WordOption[] = [
  { word: 'counterpuncher', len: 14, tier: 'insane' },
  { word: '', len: 14, tier: 'insane', hidden: true },
];
const HIDDEN: readonly WordOption[] = WORDS.map(({ len, tier }) => ({ word: '', len, tier, hidden: true }));
/** Plates are shown over the hard court's mid shade, as in a match. */
const BACKDROP = PAL.hard;
/** Room around the plates and their name chips for the halo and a 2 px shake. */
const PAD = 4;
const GAP = 8;
/**
 * Left end and spacing of a far-band row: a name chip there hangs beside its plate (left of a plate
 * left of the screen centre), so each needs a gap wider than a 3-letter chip (≤ 21 px) before it.
 */
const BESIDE_GAP = 26;
/** Buffer row for most states: far enough below the HUD band that name chips sit above the plate. */
const MID_Y = 60;
/** Feet x of the near server on the deuce side and the far one on the ad side (x ≈ 262 and 251), seen from end 0. */
const NEAR_SERVER_X = project({ ...serverSpot(0, 'deuce'), z: 0 }, 0).x;
const FAR_SERVER_X = project({ ...serverSpot(1, 'ad'), z: 0 }, 0).x;

type Belt = keyof typeof BELT_COLOR;
/** A belt's colour: the mid shade of its cloth ramp. */
const belt = (b: Belt): string => RAMPS.cloth[BELT_COLOR[b]]![1];

const BASE: Omit<PlateDraw, 'box' | 'opt' | 'scale'> = {
  typed: 0,
  locked: true,
  faded: 0,
  style: 'localActive',
  lastWrongAgeMs: null,
  isNextCursor: false,
  showInitialBlock: false,
  nameChip: null,
  oppColor: null,
  reduceEffects: false,
};

type Per = (i: number, opt: WordOption) => Partial<PlateDraw>;

interface TrioOpts { words?: readonly WordOption[]; scale?: 1 | 2; y?: number; x?: number; gap?: number }

/**
 * The three sample plates (or `words`) side by side at `scale` on buffer row `y` from buffer column `x`,
 * `gap` (× scale) apart, each customised by `per`.
 */
function trio(per: Per, { words = WORDS, scale = 1, y = MID_Y, x = 0, gap = GAP }: TrioOpts = {}): PlateDraw[] {
  let left = x;
  return words.map((opt, i) => {
    const box = { x: left, y, w: plateWidth(opt.len, scale), h: 16 * scale, option: i };
    left += box.w + gap * scale;
    return { ...BASE, box, opt, scale, ...per(i, opt) };
  });
}

interface LaidOutOpts { words?: readonly WordOption[]; all?: Partial<PlateDraw>; locked?: Partial<PlateDraw> }

/**
 * Serve options placed by a layout function (the near server's stack or the far server's row) in
 * `words`: all unlocked, or option `large` locked and redrawn at 2× (Large words) while the others
 * fade out; `all` customises every plate, `locked` the locked one.
 */
function laidOut(
  boxes: PlateDraw['box'][],
  large: number | null = null,
  { words = WORDS, all = {}, locked = {} }: LaidOutOpts = {},
): PlateDraw[] {
  return boxes.map((box) => {
    const big = box.option === large;
    return {
      ...BASE,
      box,
      opt: words[box.option] ?? words[0]!,
      scale: big ? 2 : 1,
      locked: big,
      showInitialBlock: large === null,
      faded: large === null || big ? 0 : 0.5,
      ...all,
      ...(big ? locked : {}),
    };
  });
}

const pick = <T>(values: readonly T[], i: number): T => values[i] ?? values[0]!;

/** Every plate state (spec §4.2) with its label, in drawing order. */
export const plateStates = (): { label: string; plates: PlateDraw[] }[] => [
  { label: 'idle: unlocked options, first letter as a tier block', plates: trio(() => ({ locked: false, showInitialBlock: true })) },
  { label: 'next: locked, cursor on the first letter', plates: trio(() => ({ isNextCursor: true })) },
  { label: 'typed: 1 / 4 / 7 letters', plates: trio((i) => ({ typed: pick([1, 4, 7], i), isNextCursor: true })) },
  { label: 'done: every letter typed', plates: trio((_, o) => ({ typed: o.len, isNextCursor: true })) },
  {
    label: 'wrong key: fill flash (80 ms), no shake',
    plates: trio((i) => ({ typed: pick([0, 3, 6], i), isNextCursor: true, lastWrongAgeMs: 30, reduceEffects: true })),
  },
  {
    label: 'wrong key: shake +2 / -2 / +1 px',
    plates: trio((i) => ({ typed: pick([0, 3, 6], i), isNextCursor: true, lastWrongAgeMs: pick([0, 20, 40], i) })),
  },
  {
    label: 'other options fading: 25 / 50 / 75 %',
    plates: trio((i) => ({ locked: false, showInitialBlock: true, faded: pick([0.25, 0.5, 0.75], i) })),
  },
  {
    label: 'remote: typed 1 / 4 / 7, name chips (white, yellow, green belts)',
    plates: trio((i) => ({
      style: 'remote',
      typed: pick([1, 4, 7], i),
      nameChip: pick(['alexandra', 'bo', 'kim'], i),
      oppColor: belt(pick<Belt>(['white', 'yellow', 'green'], i)),
    })),
  },
  {
    label: 'remote in the far prompt band: chips beside, away from the screen centre (brown, black, white belts)',
    plates: trio(
      (i) => ({
        style: 'remote',
        typed: pick([2, 5, 7], i),
        nameChip: pick(['sam', 'jo', 'Zoe'], i),
        oppColor: belt(pick<Belt>(['brown', 'black', 'white'], i)),
      }),
      { y: BANDS.far[0], x: BESIDE_GAP, gap: BESIDE_GAP },
    ),
  },
  {
    label: 'remote wrong key: shake, no flash',
    plates: trio((i) => ({ style: 'remote', typed: pick([0, 3, 6], i), lastWrongAgeMs: 0 })),
  },
  { label: 'hidden remote: nothing typed', plates: trio(() => ({ style: 'hiddenRemote' }), { words: HIDDEN }) },
  {
    label: 'hidden remote: half typed',
    plates: trio((_, o) => ({ style: 'hiddenRemote', typed: Math.floor(o.len / 2) }), { words: HIDDEN }),
  },
  { label: 'hidden remote: all typed', plates: trio((_, o) => ({ style: 'hiddenRemote', typed: o.len }), { words: HIDDEN }) },
  { label: '2× (large words): next', plates: trio(() => ({ isNextCursor: true }), { scale: 2 }) },
  { label: '2× (large words): typed 1 / 4 / 7', plates: trio((i) => ({ typed: pick([1, 4, 7], i), isNextCursor: true }), { scale: 2 }) },
  { label: 'near serve stack (layoutServeNear)', plates: laidOut(layoutServeNear([3, 8, 14], 240, 150)) },
  { label: 'far serve row (layoutServeFar)', plates: laidOut(layoutServeFar([3, 8, 14], 240)) },
  {
    label: 'near serve stack, deuce side, medium locked at 2× (Large words): grown left and up, clear of the toss',
    plates: laidOut(layoutServeNear([3, 8, 14], NEAR_SERVER_X, 150, 1), 1, { locked: { typed: 3, isNextCursor: true } }),
  },
  {
    label: 'far serve row, ad side, hard locked at 2× (Large words): grown right of the toss gap, a 1× chip where 2× has no room',
    plates: laidOut(layoutServeFar([3, 8, 14], FAR_SERVER_X, 2), 2, {
      words: HIDDEN,
      all: { style: 'hiddenRemote' },
      locked: { typed: 5, nameChip: 'kai', oppColor: belt('brown') },
    }),
  },
  {
    label: 'insane: 4 pips, 5 letters typed; hidden remote with 3 typed',
    plates: trio((i) => (i === 0 ? { typed: 5, isNextCursor: true } : { style: 'hiddenRemote', typed: 3 }), { words: INSANE_WORDS }),
  },
];

/** The buffer rectangle a state's canvas shows: its plates and name chips plus room for halos and shakes. */
export function stateBounds(plates: PlateDraw[]): { left: number; top: number; right: number; bottom: number } {
  const rects = plates.flatMap((p) => [
    p.box,
    ...(p.nameChip === null ? [] : [nameChipBox(p.nameChip, p.box.x, p.box.y, p.box.w, p.scale)]),
  ]);
  return {
    left: Math.min(...rects.map((r) => r.x)) - PAD,
    top: Math.min(...rects.map((r) => r.y)) - PAD,
    right: Math.max(...rects.map((r) => r.x + r.w)) + PAD,
    bottom: Math.max(...rects.map((r) => r.y + r.h)) + PAD,
  };
}

/** One state's plates at 1× over the court colour, cropped to `stateBounds`. */
function stateCanvas(plates: PlateDraw[]): HTMLCanvasElement {
  const { left, top, right, bottom } = stateBounds(plates);
  const { canvas, g } = newCanvas(right - left, bottom - top);
  g.fillStyle = BACKDROP;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.translate(-left, -top);
  for (const p of plates) drawPlate(g, p);
  return canvas;
}

/**
 * Section `plates`: every plate state for words of 3, 8 and 14 letters (easy, medium, hard), plus the
 * serve stack and row layouts (unlocked, and with a locked word at 2×), over the hard court colour at
 * 1× and then 4×.
 */
export function drawPlatesSection(parent: HTMLElement): void {
  const section = addSection(parent, 'plates', 'plates: every state, words of 3 / 8 / 14 letters over the hard court');
  const states = plateStates().map(({ label, plates }) => ({ label, one: stateCanvas(plates) }));
  for (const k of [1, K]) {
    addHeading(section, `${k}×`);
    for (const { label, one } of states) addFigure(addRow(section, label), k === 1 ? one : scaled(one, k));
  }
}
