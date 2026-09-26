import type { WordOption } from '../../src/core/types';
import { BANDS, layoutServeFar, layoutServeNear, plateWidth } from '../../src/render/layout';
import { BELT_COLOR, PAL, RAMPS } from '../../src/render/palette';
import { drawPlate, type PlateDraw } from '../../src/render/plates';
import { addFigure, addHeading, addRow, addSection, newCanvas, scaled } from './dom';

const K = 4;
/** One word per tier at lengths 3, 8 and 14 (tiers follow length), with ascenders and descenders. */
const WORDS: readonly WordOption[] = [
  { word: 'jog', len: 3, tier: 'easy' },
  { word: 'skipping', len: 8, tier: 'medium' },
  { word: 'counterpuncher', len: 14, tier: 'hard' },
];
const HIDDEN: readonly WordOption[] = WORDS.map(({ len, tier }) => ({ word: '', len, tier, hidden: true }));
/** Plates are shown over the hard court's mid shade, as in a match. */
const BACKDROP = PAL.hard;
/** Room around the plates for the halo and a 2 px shake; name chips get their height on both sides. */
const PAD = 4;
const CHIP_ROOM = 11;
const GAP = 8;
/** Buffer row for most states: far enough below the HUD band that name chips sit above the plate. */
const MID_Y = 60;

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

interface TrioOpts { words?: readonly WordOption[]; scale?: 1 | 2; y?: number }

/** The three sample plates (or `words`) side by side at `scale` on buffer row `y`, each customised by `per`. */
function trio(per: Per, { words = WORDS, scale = 1, y = MID_Y }: TrioOpts = {}): PlateDraw[] {
  let x = 0;
  return words.map((opt, i) => {
    const box = { x, y, w: plateWidth(opt.len, scale), h: 16 * scale, option: i };
    x += box.w + GAP * scale;
    return { ...BASE, box, opt, scale, ...per(i, opt) };
  });
}

/** Unlocked serve options placed by a layout function (the near server's stack or the far server's row). */
function laidOut(boxes: PlateDraw['box'][]): PlateDraw[] {
  return boxes.map((box) => ({
    ...BASE,
    box,
    opt: WORDS[box.option] ?? WORDS[0]!,
    scale: 1,
    locked: false,
    showInitialBlock: true,
  }));
}

const pick = <T>(values: readonly T[], i: number): T => values[i] ?? values[0]!;

/** Every plate state (spec §4.2), in drawing order. */
const plateStates = (): { label: string; plates: PlateDraw[] }[] => [
  { label: 'idle: unlocked options, first letter as a tier block', plates: trio(() => ({ locked: false, showInitialBlock: true })) },
  { label: 'next: locked, cursor on the first letter', plates: trio(() => ({ isNextCursor: true })) },
  { label: 'typed: 1 / 4 / 9 letters', plates: trio((i) => ({ typed: pick([1, 4, 9], i), isNextCursor: true })) },
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
    label: 'remote: typed 1 / 4 / 9, name chips (white, yellow, green belts)',
    plates: trio((i) => ({
      style: 'remote',
      typed: pick([1, 4, 9], i),
      nameChip: pick(['alexandra', 'bo', 'kim'], i),
      oppColor: belt(pick<Belt>(['white', 'yellow', 'green'], i)),
    })),
  },
  {
    label: 'remote in the far prompt band: chips below (brown, black, white belts)',
    plates: trio(
      (i) => ({
        style: 'remote',
        typed: pick([2, 5, 11], i),
        nameChip: pick(['sam', 'jo', 'Zoe'], i),
        oppColor: belt(pick<Belt>(['brown', 'black', 'white'], i)),
      }),
      { y: BANDS.far[0] },
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
  { label: '2× (large words): typed 1 / 4 / 9', plates: trio((i) => ({ typed: pick([1, 4, 9], i), isNextCursor: true }), { scale: 2 }) },
  { label: 'near serve stack (layoutServeNear)', plates: laidOut(layoutServeNear([3, 8, 14], 240, 150)) },
  { label: 'far serve row (layoutServeFar)', plates: laidOut(layoutServeFar([3, 8, 14], 240)) },
];

/** One state's plates at 1× over the court colour, cropped to the plates plus room for halos, shakes and chips. */
function stateCanvas(plates: PlateDraw[]): HTMLCanvasElement {
  const chip = plates.some((p) => p.nameChip !== null) ? CHIP_ROOM * Math.max(...plates.map((p) => p.scale)) : 0;
  const left = Math.min(...plates.map((p) => p.box.x)) - PAD;
  const top = Math.min(...plates.map((p) => p.box.y)) - PAD - chip;
  const right = Math.max(...plates.map((p) => p.box.x + p.box.w)) + PAD;
  const bottom = Math.max(...plates.map((p) => p.box.y + p.box.h)) + PAD + chip;
  const { canvas, g } = newCanvas(right - left, bottom - top);
  g.fillStyle = BACKDROP;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.translate(-left, -top);
  for (const p of plates) drawPlate(g, p);
  return canvas;
}

/**
 * Section `plates`: every plate state for words of 3, 8 and 14 letters (easy, medium, hard), plus the
 * serve stack and row layouts, over the hard court colour at 1× and then 4×.
 */
export function drawPlatesSection(parent: HTMLElement): void {
  const section = addSection(parent, 'plates', 'plates: every state, words of 3 / 8 / 14 letters over the hard court');
  const states = plateStates().map(({ label, plates }) => ({ label, one: stateCanvas(plates) }));
  for (const k of [1, K]) {
    addHeading(section, `${k}×`);
    for (const { label, one } of states) addFigure(addRow(section, label), k === 1 ? one : scaled(one, k));
  }
}
