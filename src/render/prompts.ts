import { turnViewAt, type PromptView, type TurnView } from '../core/turnView';
import type {
  DisplayPrefs,
  Look,
  PlayerId,
  ReturnTurnData,
  ServeTurnData,
  Tier,
  TurnState,
  Vec2,
  WordOption,
} from '../core/types';
import { clamp } from '../core/util';
import { drawText, textWidth } from './font';
import { beltColor } from './hud';
import { layoutChoice, layoutServeFar, layoutServeNear, layoutSingle, type PlateBox } from './layout';
import { OUTLINE, PAL } from './palette';
import { drawPlate, drawTimingBar, type PlateDraw, type PlateStyle, type Pt } from './plates';
import type { PlayerPose } from './players';
import { createLayer, type Layer } from './screen';
import { CELL, type View } from './sprites/animations';
import { SLOT } from './sprites/parts';
import { composeFrame } from './sprites/rig';
import { groundAt, type WorldFrame } from './world';

// Prompts: court-space UI (rings, leaders, markers) and word plates (spec §4.2).

const headHeights = new Map<string, number>();

/**
 * Pixels from the feet anchor row up to the top of a standing player's head (hair and headband
 * included) for `look` seen from `view`, measured once per head from the composed idle frame.
 */
export function headHeight(look: Look, view: View): number {
  const band = look.headband !== null;
  const key = `${look.hairStyle}:${band}:${view}`;
  let h = headHeights.get(key);
  if (h === undefined) {
    const buf = composeFrame('idle', view, 0, look.hairStyle, band);
    const first = buf.findIndex((slot) => slot !== SLOT.clear);
    h = CELL.anchorY - (first < 0 ? CELL.anchorY : Math.floor(first / CELL.w));
    headHeights.set(key, h);
  }
  return h;
}

/** A ground ring at screen (x, y); `alpha` 0–1. The world pass draws it, depth-sorted with the players (R33). */
export interface RingMark { tier: Tier; x: number; y: number; alpha: number }
/** A choice leader: a polyline from its plate to its ring centre (the last point); the world pass draws it under the players (R42). */
export interface LeaderMark { points: Pt[]; tier: Tier; alpha: number }
/** The local typist's timing bar: remaining share `frac`, checker in the grace window. */
export interface BarMark { x: number; y: number; w: number; frac: number; grace: boolean }
/** The opponent's serve plate turning over at the strike: `step` 0–3 (hidden face on 0–1, revealed on 2–3). */
export interface FlipMark { hidden: PlateDraw; revealed: PlateDraw; step: number }
/** A tag above the viewer's player (`wait`, `space` keycap) or the first-letter label under the choice row; (x, y) is its top centre. */
export interface TagMark { kind: 'wait' | 'space' | 'hint'; x: number; y: number }

/** Everything the prompt layer draws this frame. */
export interface PromptScene {
  plates: PlateDraw[];
  rings: RingMark[];
  leaders: LeaderMark[];
  bar: BarMark | null;
  flip: FlipMark | null;
  pops: PlateBox[];
  tags: TagMark[];
}

/**
 * Inputs of the prompt layer besides the frame: display prefs, the players' looks (for head heights),
 * where each player stood when the turn began (chase plates stay there) and whether the local
 * player just became the active typist (2-frame border pop).
 */
export interface PromptOptions {
  prefs: DisplayPrefs;
  looks: readonly [Look, Look];
  turnStart: readonly [Vec2, Vec2];
  pop: boolean;
}

/** How long unlocked options take to fade out after a lock. */
const OPTION_FADE_MS = 200;
/**
 * How long a completed chase plate takes to fade out, and with it the opponent's revealed serve plate
 * (the same word), so neither meets the choice row that appears at once (R42: within 150 ms).
 */
const CHASE_FADE_MS = 100;
/** Gap between a plate's bottom and its timing bar. */
const BAR_GAP = 2;
/** The reveal flip: 4 steps of 50 ms, the revealed plate then holds until 700 ms and fades by 900 ms. */
const FLIP_STEP_MS = 50;
const FLIP_STEPS = 4;
const REVEAL_HOLD_MS = 700;
const REVEAL_FADE_MS = 200;
/** Plate area limits (spec §4.2). */
const AREA = { left: 4, right: 476, top: 22, bottom: 266 };
const HEAD_GAP = 4;
const TAG_H = 11;
/**
 * Centres for the "type a first letter" label under the far choice row: the gaps between the slot
 * centres (90 / 240 / 390); the one farther from the opponent keeps the label off their sprite.
 */
const HINT_X = [165, 315] as const;
/** The same for a 4-plate choice row (slot centres 60 / 180 / 300 / 420): the gaps of the outer pairs. */
const HINT_X4 = [120, 360] as const;
const KEYCAP_H = 13;
const KEYCAP_BOB_MS = 400;

interface Ctx {
  f: WorldFrame;
  t: TurnState;
  v: TurnView;
  poses: readonly [PlayerPose, PlayerPose];
  o: PromptOptions;
  s: PromptScene;
}

/** Screen x and head-top y of player `p` standing at `feet`. */
function headAt(c: Ctx, p: PlayerId, feet: Vec2): { x: number; y: number } {
  const at = groundAt(c.f, feet);
  return { x: at.x, y: Math.round(at.y) - headHeight(c.o.looks[p], p === c.f.near ? 'near' : 'far') };
}

/** τ of the lock key of prompt `id` if it happened by τ. */
function lockTime(t: TurnState, id: number, τ: number): number | null {
  for (const e of t.log) {
    if (e.τ > τ) break;
    if (e.k === 'lock' && e.prompt === id) return e.τ;
  }
  return null;
}

function styleFor(f: WorldFrame, owner: PlayerId, options: WordOption[]): PlateStyle {
  if (f.local === owner) return 'localActive';
  return options.some((o) => o.hidden) ? 'hiddenRemote' : 'remote';
}

function plate(c: Ctx, box: PlateBox, opt: WordOption, style: PlateStyle, over: Partial<PlateDraw>): PlateDraw {
  return {
    box,
    opt,
    typed: 0,
    locked: false,
    faded: 0,
    style,
    lastWrongAgeMs: null,
    isNextCursor: false,
    showInitialBlock: false,
    nameChip: null,
    oppColor: null,
    scale: 1,
    reduceEffects: c.o.prefs.reduceEffects,
    ...over,
  };
}

/**
 * A choice plate redrawn at 2× around the same centre column, top unchanged, kept inside the plate
 * area. Serve plates grow away from the toss column instead (`layoutServeNear`/`layoutServeFar`).
 */
function doubled(box: PlateBox): PlateBox {
  const w = box.w * 2;
  const h = box.h * 2;
  const cx = box.x + (box.w - 1) / 2;
  return {
    x: clamp(Math.round(cx - (w - 1) / 2), AREA.left, AREA.right - w),
    y: clamp(box.y, AREA.top, AREA.bottom - h),
    w,
    h,
    option: box.option,
  };
}

/** The remote chip: owner's name and belt colour, or nothing for the local typist. */
function chipOf(c: Ctx, owner: PlayerId, style: PlateStyle): { name: string; color: string } | null {
  if (style === 'localActive') return null;
  const info = c.f.pub.players[owner];
  return { name: info.name, color: beltColor(info) };
}

/** The option of `prompt` drawn at 2×: the locked word, with Large words (spec §4.2). */
function largeOption(c: Ctx, prompt: PromptView): number | null {
  return c.o.prefs.largeWords ? prompt.locked : null;
}

/**
 * The plates of a three-option prompt in `boxes`, option `large` at 2× (its box already doubled):
 * after a lock the other options fade out. Returns `boxes`.
 */
function optionPlates(
  c: Ctx,
  prompt: PromptView,
  boxes: PlateBox[],
  large: number | null,
  style: PlateStyle,
  owner: PlayerId,
): PlateBox[] {
  const lockAt = lockTime(c.t, prompt.id, c.f.τ);
  const chip = chipOf(c, owner, style);
  const wrongAge = prompt.lastWrongAt === null ? null : c.f.τ - prompt.lastWrongAt;
  const local = style === 'localActive';
  return prompt.options.map((opt, i) => {
    const locked = prompt.locked === i;
    const box = boxes[i]!;
    const faded = prompt.locked !== null && !locked && lockAt !== null ? clamp((c.f.τ - lockAt) / OPTION_FADE_MS, 0, 1) : 0;
    c.s.plates.push(
      plate(c, box, opt, style, {
        typed: locked ? prompt.typed : 0,
        locked,
        faded,
        lastWrongAgeMs: wrongAge,
        isNextCursor: local && locked,
        showInitialBlock: local && prompt.locked === null,
        nameChip: chip && i === (prompt.locked ?? 0) ? chip.name : null,
        oppColor: chip?.color ?? null,
        scale: i === large ? 2 : 1,
      }),
    );
    return box;
  });
}

/**
 * The serve plates of `server` with its head at `head` (spec §4.2, R34): the near stack or the far
 * row, option `large` at 2× grown away from the toss column.
 */
function serveLayout(c: Ctx, server: PlayerId, lens: number[], head: { x: number; y: number }, large: number | null): PlateBox[] {
  return server === c.f.near ? layoutServeNear(lens, head.x, head.y, large) : layoutServeFar(lens, head.x, large);
}

/** The option fade of plate `i` among the plates just added (1 − its opacity). */
function fadeOf(c: Ctx, count: number, i: number): number {
  return c.s.plates[c.s.plates.length - count + i]?.faded ?? 0;
}

/** Share 0–1 of a `CHASE_FADE_MS` fade at τ that started at `from` (0 while `from` is null). */
function chaseFade(τ: number, from: number | null): number {
  return from === null ? 0 : clamp((τ - from) / CHASE_FADE_MS, 0, 1);
}

function barUnder(boxes: PlateBox[], frac: number, grace: boolean): BarMark {
  const x = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y: bottom + BAR_GAP, w: right - x, frac: clamp(frac, 0, 1), grace };
}

/** Serve toss: the serve words (3, or 4 at a full meter) above/beside the server, markers in the box for its owner. */
function servePrompts(c: Ctx, d: ServeTurnData): void {
  const { f, v, s } = c;
  const prompt = v.phase === 'toss' && v.active !== null ? v.prompts[v.active] : undefined;
  if (!prompt || v.tossAt === null) return;
  const server = d.owner;
  const style = styleFor(f, server, prompt.options);
  const lens = prompt.options.map((o) => o.len);
  const head = headAt(c, server, c.poses[server].feet);
  const large = largeOption(c, prompt);
  const boxes = optionPlates(c, prompt, serveLayout(c, server, lens, head, large), large, style, server);
  const n = prompt.options.length;
  const targets = d.wordSets[v.active ?? 0]?.targets ?? [];
  if (targets.length === n) {
    targets.forEach((p, i) => {
      const at = groundAt(f, p);
      s.rings.push({ tier: prompt.options[i]!.tier, x: at.x, y: at.y, alpha: 1 - fadeOf(c, n, i) });
    });
  }
  if (style !== 'localActive') return;
  const since = v.simτ - turnViewAt(c.t, v.tossAt).simτ;
  const frac = 1 - since / (2 * d.tossApexMs * d.pace);
  s.bar = barUnder(prompt.locked === null ? boxes : [boxes[prompt.locked]!], frac, false);
  if (c.o.pop) s.pops.push(...boxes);
}

/** Remaining share of the time to contact from `fromSim`, then of the grace window (spec §4.2 timing bar). */
function contactShare(v: TurnView, d: ReturnTurnData, fromSim: number): { frac: number; grace: boolean } {
  const { T, grace } = d.incoming;
  if (v.simτ <= T) return { frac: (T - v.simτ) / Math.max(1, T - fromSim), grace: false };
  return { frac: (T + grace - v.simτ) / Math.max(1, grace), grace: true };
}

/** The chase plate, fading out once its word is complete; the local typist's timing bar and pop until then. */
function chasePlate(c: Ctx, d: ReturnTurnData, chase: PromptView, style: PlateStyle): void {
  const faded = chaseFade(c.f.τ, chase.completedAt);
  if (faded >= 1) return;
  const owner = d.owner;
  const head = headAt(c, owner, c.o.turnStart[owner]);
  const scale = c.o.prefs.largeWords ? 2 : 1;
  const opt = chase.options[0]!;
  const box = layoutSingle(opt.len, head.x, head.y, scale);
  const chip = chipOf(c, owner, style);
  const local = style === 'localActive';
  c.s.plates.push(
    plate(c, box, opt, style, {
      typed: chase.typed,
      locked: true,
      faded,
      lastWrongAgeMs: chase.lastWrongAt === null ? null : c.f.τ - chase.lastWrongAt,
      isNextCursor: local,
      nameChip: chip?.name ?? null,
      oppColor: chip?.color ?? null,
      scale,
    }),
  );
  if (!local || chase.completedAt !== null) return;
  const share = contactShare(c.v, d, 0);
  c.s.bar = barUnder([box], share.frac, share.grace);
  if (c.o.pop) c.s.pops.push(box);
}

function choicePlates(c: Ctx, d: ReturnTurnData, choice: PromptView, style: PlateStyle): void {
  const { f, v, s } = c;
  const band = d.striker === f.near ? 'near' : 'far';
  // A full meter pre-picks 4 targets; a chase slip leaves the prompt showing only the first 3.
  const targets = d.choice.targets.slice(0, choice.options.length).map((p) => groundAt(f, p));
  const layout = layoutChoice(
    choice.options.map((o) => o.len),
    targets.map((p) => p.x),
    band,
  );
  const large = largeOption(c, choice);
  const boxes = optionPlates(c, choice, layout.map((b, i) => (i === large ? doubled(b) : b)), large, style, d.owner);
  const n = choice.options.length;
  targets.forEach((to, i) => {
    const tier = choice.options[i]!.tier;
    const alpha = 1 - fadeOf(c, n, i);
    const box = layout[i]!;
    s.rings.push({ tier, x: to.x, y: to.y, alpha });
    s.leaders.push({ points: [{ x: box.x + Math.floor(box.w / 2), y: box.y + box.h }, { x: to.x, y: to.y }], tier, alpha });
  });
  if (style !== 'localActive' || v.phase !== 'choice') return;
  const share = contactShare(v, d, turnViewAt(c.t, choice.shownAt).simτ);
  s.bar = barUnder(choice.locked === null ? boxes : [boxes[choice.locked]!], share.frac, share.grace);
  if (f.vm.overlay.hintFirstLetter && choice.locked === null) {
    const farX = groundAt(f, c.poses[d.striker].feet).x;
    const [left, right] = choice.options.length === 4 ? HINT_X4 : HINT_X;
    s.tags.push({ kind: 'hint', x: Math.abs(farX - left) >= Math.abs(farX - right) ? left : right, y: s.bar.y + 5 });
  }
}

/**
 * The opponent's hidden serve plate turning over as the return turn begins (spec §4.2): a 4-step
 * flip to the struck word (the chase word), which then holds and fades, or fades at once when the
 * chase word is complete (R42). It turns over in the box the word was locked in, 2× with Large words.
 * Only for a viewer who saw the serve words hidden.
 */
function revealServe(c: Ctx, d: ReturnTurnData): void {
  const last = c.f.last?.turn;
  if (!last || last.data.kind !== 'serve' || last.outcome?.kind !== 'strike') return;
  const server = last.data.owner;
  const prompt = last.prompts[last.prompts.length - 1];
  const τ = c.f.τ;
  if (c.f.local === null || c.f.local === server || !prompt || τ >= REVEAL_HOLD_MS + REVEAL_FADE_MS) return;
  if (!prompt.options.some((o) => o.hidden)) return;
  const chaseDone = c.v.prompts.find((p) => p.kind === 'chase')?.completedAt ?? null;
  const ending = chaseFade(τ, chaseDone);
  if (ending >= 1) return;
  const option = last.outcome.strike.option;
  const lens = prompt.options.map((o) => o.len);
  const head = headAt(c, server, c.o.turnStart[server]);
  const large = c.o.prefs.largeWords ? option : null;
  const box = serveLayout(c, server, lens, head, large)[option];
  if (!box) return;
  const word = d.chase;
  const chip = chipOf(c, server, 'remote');
  const common: Partial<PlateDraw> = {
    typed: word.len,
    locked: true,
    nameChip: chip?.name ?? null,
    oppColor: chip?.color ?? null,
    scale: large === null ? 1 : 2,
  };
  const revealed = plate(c, box, word, 'remote', common);
  if (τ < FLIP_STEP_MS * FLIP_STEPS && chaseDone === null) {
    const back: WordOption = { word: '', len: word.len, tier: word.tier, hidden: true };
    c.s.flip = { hidden: plate(c, box, back, 'hiddenRemote', common), revealed, step: Math.floor(τ / FLIP_STEP_MS) };
    return;
  }
  c.s.plates.push({ ...revealed, faded: Math.max(ending, clamp((τ - REVEAL_HOLD_MS) / REVEAL_FADE_MS, 0, 1)) });
}

function returnPrompts(c: Ctx, d: ReturnTurnData): void {
  revealServe(c, d);
  const { v } = c;
  if (v.outcome) return;
  const [chase, choice] = v.prompts;
  const style = styleFor(c.f, d.owner, chase?.options ?? []);
  if (chase) chasePlate(c, d, chase, style);
  if (choice && (v.phase === 'choice' || v.phase === 'queued')) choicePlates(c, d, choice, style);
}

/** WAIT tag and SPACE keycap above the viewer's own player. */
function playerTags(c: Ctx): void {
  const me = c.f.local;
  const { overlay } = c.f.vm;
  if (me === null || (!overlay.wait && !overlay.hintSpace)) return;
  const head = headAt(c, me, c.poses[me].feet);
  let y = head.y - HEAD_GAP;
  if (overlay.hintSpace) {
    const bob = Math.floor(c.f.τ / KEYCAP_BOB_MS) % 2;
    y -= KEYCAP_H;
    c.s.tags.push({ kind: 'space', x: head.x, y: Math.max(AREA.top, y - bob) });
    y -= 2;
  }
  if (overlay.wait) c.s.tags.push({ kind: 'wait', x: head.x, y: Math.max(AREA.top, y - TAG_H) });
}

/**
 * What the prompt layer shows this frame (spec §4.2), or nothing while paused or counting down:
 * serve words (local-active stack, the opponent's hidden plates, spectators' remote plates) with
 * their box markers; the chase plate above the owner's turn-start head (fading out once complete);
 * the choice row in the band of the targeted half with rings and leaders; the local timing bar; the
 * serve reveal flip; the border pop; the WAIT tag, SPACE keycap and first-letter hint.
 */
export function promptScene(f: WorldFrame, poses: readonly [PlayerPose, PlayerPose], o: PromptOptions): PromptScene {
  const s: PromptScene = { plates: [], rings: [], leaders: [], bar: null, flip: null, pops: [], tags: [] };
  const { overlay } = f.vm;
  if (overlay.paused || overlay.countdown !== null || f.turn === null || f.view === null) return s;
  const c: Ctx = { f, t: f.turn, v: f.view, poses, o, s };
  if (f.turn.data.kind === 'serve') servePrompts(c, f.turn.data);
  else returnPrompts(c, f.turn.data);
  playerTags(c);
  return s;
}

/** Vertical scale of the flipping plate per step (edge-on in the middle). */
const FLIP_SCALE = [0.6, 0.2, 0.2, 0.6];
let flipLayer: Layer | null = null;

function drawFlip(ctx: CanvasRenderingContext2D, flip: FlipMark): void {
  const p = flip.step < FLIP_STEPS / 2 ? flip.hidden : flip.revealed;
  const { box } = p;
  const layer = (flipLayer ??= createLayer(200, 40));
  layer.g.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  drawPlate(layer.g, { ...p, box: { ...box, x: 0, y: 0 }, nameChip: null, lastWrongAgeMs: null });
  const h = Math.max(2, Math.round(box.h * (FLIP_SCALE[flip.step] ?? 1)));
  ctx.drawImage(layer.canvas, 0, 0, box.w, box.h, box.x, box.y + Math.round((box.h - h) / 2), box.w, h);
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** A labelled tag: outlined box of `fill` with `text` in `ink`, `lip` px of `lipColor` along the bottom. */
function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  h: number,
  colors: { fill: string; ink: string; lip?: string },
): void {
  const w = textWidth(text) + 8;
  const x = Math.round(cx - w / 2);
  rect(ctx, x, y, w, h, OUTLINE);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, colors.fill);
  if (colors.lip) rect(ctx, x + 1, y + h - 4, w - 2, 3, colors.lip);
  drawText(ctx, text, x + 4, y + 1, colors.ink);
}

function drawTags(ctx: CanvasRenderingContext2D, tags: TagMark[]): void {
  for (const t of tags) {
    if (t.kind === 'wait') drawTag(ctx, 'WAIT', t.x, t.y, TAG_H, { fill: PLATE_FILL, ink: PAL.silver });
    else if (t.kind === 'space') drawTag(ctx, 'SPACE', t.x, t.y, KEYCAP_H, { fill: PAL.mist, ink: OUTLINE, lip: PAL.grey });
    else drawTag(ctx, 'TYPE A FIRST LETTER', t.x, t.y, TAG_H, { fill: PLATE_FILL, ink: PAL.cream });
  }
}

const PLATE_FILL = PAL.night;

/** Plate draw order: fading plates at the bottom, then unlocked options, the locked word on top. */
const plateLayer = (p: PlateDraw): number => (p.faded > 0 ? 0 : p.locked ? 2 : 1);

/**
 * Draws the prompt layer over the world: plates (fading ones first, then unlocked options, the locked
 * word last), the timing bar, the reveal flip, the 2-frame white border pop and the tags. The ground
 * rings and leaders are not drawn here: `drawWorld` depth-sorts the rings with the players and draws
 * the leaders under them (R33, R42).
 */
export function drawPrompts(ctx: CanvasRenderingContext2D, s: PromptScene): void {
  for (const p of [...s.plates].sort((a, b) => plateLayer(a) - plateLayer(b))) drawPlate(ctx, p);
  if (s.bar) drawTimingBar(ctx, s.bar.x, s.bar.y, s.bar.w, s.bar.frac, s.bar.grace);
  if (s.flip) drawFlip(ctx, s.flip);
  for (const b of s.pops) {
    rect(ctx, b.x - 2, b.y - 2, b.w + 4, 1, PAL.white);
    rect(ctx, b.x - 2, b.y + b.h + 1, b.w + 4, 1, PAL.white);
    rect(ctx, b.x - 2, b.y - 1, 1, b.h + 2, PAL.white);
    rect(ctx, b.x + b.w + 1, b.y - 1, 1, b.h + 2, PAL.white);
  }
  drawTags(ctx, s.tags);
}
