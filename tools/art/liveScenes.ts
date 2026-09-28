import type { DisplayPrefs, Surface } from '../../src/core/types';
import { H, W } from '../../src/render/projection';
import { Renderer } from '../../src/render/renderer';
import type { Screen } from '../../src/render/screen';
import { addFigure, addHeading, addRow, addSection, newCanvas, scaled } from './dom';
import { FRAME_MS, LIVE_MOMENTS, LIVE_VIEWER, liveSetup, matchFrames, planShots, viewAs, type ShotPlan } from './liveMatch';

const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];
const BIG = 3;
/** 1× frames per row. */
const PER_ROW = 3;
/** The display options of a new player (DEFAULT_SETTINGS). */
const PREFS: DisplayPrefs = { largeWords: false, reduceEffects: false, showWpm: true };

/** A shot: its plan and the frame the Renderer drew on the plan's frame, at 1×. */
interface Shot { plan: ShotPlan; canvas: HTMLCanvasElement }

/**
 * A Renderer drawing into its own 480×270 buffer and presenting nowhere: a Renderer uses nothing of its
 * Screen but `buf` and `present`.
 */
function offscreenRenderer(): { renderer: Renderer; buf: HTMLCanvasElement } {
  const { canvas, g } = newCanvas(W, H);
  const screen = { buf: g, present: () => {} } as unknown as Screen;
  return { renderer: new Renderer(screen), buf: canvas };
}

/** The plans' render windows, overlapping ones merged: frames `from` to `to`, each drawn by one Renderer. */
function windows(plans: readonly ShotPlan[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const p of [...plans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last !== undefined && p.from <= last.to + 1) last.to = Math.max(last.to, p.at);
    else out.push({ from: p.from, to: p.at });
  }
  return out;
}

/**
 * Plays `surface`'s live match twice: once to plan the moments, then again feeding every frame of
 * each render window to a fresh Renderer as player 0 sees it, keeping the frame drawn on each moment.
 */
function shoot(surface: Surface): Shot[] {
  const setup = liveSetup(surface);
  const plans = planShots(setup, LIVE_MOMENTS);
  const spans = windows(plans);
  const last = Math.max(...plans.map((p) => p.at));
  const drawn = new Map<ShotPlan, HTMLCanvasElement>();
  let current: { to: number; renderer: Renderer; buf: HTMLCanvasElement } | null = null;
  let i = 0;
  for (const { vm } of matchFrames(setup)) {
    if (current === null || i > current.to) {
      const span = spans.find((s) => s.from === i);
      current = span === undefined ? null : { to: span.to, ...offscreenRenderer() };
    }
    if (current !== null) {
      current.renderer.draw(viewAs(vm, LIVE_VIEWER), PREFS, FRAME_MS);
      for (const p of plans) {
        if (p.at !== i) continue;
        const { canvas, g } = newCanvas(W, H);
        g.drawImage(current.buf, 0, 0);
        drawn.set(p, canvas);
      }
    }
    if (i++ >= last) break;
  }
  return plans.map((plan) => ({ plan, canvas: drawn.get(plan)! }));
}

function caption(p: ShotPlan): string {
  return `${p.moment.label} (${((p.at * FRAME_MS) / 1000).toFixed(1)} s into the match)`;
}

/**
 * Sections `scene-live-<surface>`: full frames drawn by the real Renderer from a real match (Engine and
 * CpuBrains run headlessly, see liveMatch.ts) as player 0 sees it: the toss with typed letters, the
 * chase mid-way, the choice stack, a locked choice, a point call, the opponent's hidden serve plates
 * and MATCH POINT, at 1× and 3×.
 */
export function drawLiveSceneSections(parent: HTMLElement): void {
  for (const surface of SURFACES) {
    const section = addSection(parent, `scene-live-${surface}`, `live match, ${surface}: Alex (player 0) vs Bruno, as Alex sees it`);
    const shots = shoot(surface);
    for (let r = 0; r < shots.length; r += PER_ROW) {
      const row = addRow(section, '1×');
      for (const { plan, canvas } of shots.slice(r, r + PER_ROW)) addFigure(row, canvas, caption(plan));
    }
    for (const { plan, canvas } of shots) {
      addHeading(section, `${BIG}×: ${caption(plan)}`);
      addFigure(section, scaled(canvas, BIG));
    }
  }
}
