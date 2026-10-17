import { POWER_MAX } from '../core/power';
import { situation } from '../core/scoring';
import { TUNING } from '../core/tuning';
import type { DisplayPrefs, LeadIn, PublicState } from '../core/types';
import { drawBanner, shadowText, type Banner, type BannerLine } from './banner';
import { checker } from './court';
import { drawText, FONT, textWidth } from './font';
import { OUTLINE, PAL, TIER_COLOR, TIER_TYPED } from './palette';
import { H, W } from './projection';
import { createLayer, type Layer } from './screen';
import { BOARD, beltColor, drawScoreboard, panel, rect, scoreRowsFor, type ScoreRow } from './scoreboard';
import type { WorldFrame } from './world';

export { drawBanner, beltColor };
export type { Banner, BannerLine, ScoreRow };

/** Both scoreboard rows (spec §4.3); the serve dot marks the current server while the match is on. */
export function scoreRows(pub: PublicState): [ScoreRow, ScoreRow] {
  return scoreRowsFor(pub.score, pub.players, pub.status === 'playing' && pub.score.winner === null);
}

/** The on-screen pause button (spec §4.3), top-right in the HUD band, in 480×270 buffer pixels. */
export const PAUSE_ICON_RECT: Readonly<{ x: number; y: number; w: number; h: number }> = { x: 462, y: 3, w: 15, h: 15 };

/** One banner of a lead-in (lead-in τ): its lines with the time each joins, its span, and whether it is the point call. */
export interface LeadInBanner { lines: { text: string; atMs: number }[]; fromMs: number; toMs: number; point: boolean }

/** How long the speed readout stays after a strike, then fades. */
const SPEED_SHOW_MS = 2000;
const SPEED_FADE_MS = 500;
/** The situation banner (MATCH POINT, DEUCE…) at the start of PRE_SERVE. */
const SITUATION_MS = 1500;
/** The serve clock turns yellow (never red) for its last seconds. */
const CLOCK_WARN_S = 5;
/**
 * Centre row of "Connection unstable...": its 24 px box fills y 245–268 at the bottom centre, beside
 * the RTT readout. The typist's words keep running under it, and no plate reaches that low: serve and
 * chase plates sit above a head, which stands ≥ 40 px over feet that are never below y 257 (the
 * deepest contact point), and a choice stack beside the player ends level with the head top, so even
 * a locked word doubled downward (Large words) and its timing bar end by y 238.
 */
const UNSTABLE_CY = H - 13;

/** Whole seconds left on the serve clock during PRE_SERVE, TOSS and CATCH (spec §3.2.1), else null. */
export function serveClockSeconds(f: WorldFrame): number | null {
  const d = f.turn?.data;
  const v = f.view;
  if (d?.kind !== 'serve' || d.serveClockMs === null || !v) return null;
  if (v.phase !== 'preServe' && v.phase !== 'toss' && v.phase !== 'catch') return null;
  return Math.max(0, Math.ceil((d.leadIn.ms + d.serveClockMs - v.simτ) / 1000));
}

/** The speed of the strike that started the current return turn, for 2 s, then fading out over 0.5 s. */
export function speedReadout(f: WorldFrame): { kmh: number; alpha: number } | null {
  const o = f.last?.turn.outcome;
  if (f.turn?.data.kind !== 'return' || o?.kind !== 'strike') return null;
  const alpha = f.τ < SPEED_SHOW_MS ? 1 : 1 - (f.τ - SPEED_SHOW_MS) / SPEED_FADE_MS;
  return alpha > 0 ? { kmh: o.strike.kmh, alpha } : null;
}

/**
 * The banners a lead-in plays in order (spec §3.1, R30). A double fault's lead-in starts with the
 * fault call (FAULT + reason) for faultMs, then the point call takes over. In a point call the call
 * line shows first; the GAME and SET lines join the same banner as their parts begin (after pointMs,
 * then after gameExtraMs). An intro or a first-serve fault is one banner for the whole lead-in. If
 * `leadIn.ms` differs from the tuned total, every part is scaled to fill it.
 */
export function leadInBanners(leadIn: LeadIn): LeadInBanner[] {
  const { text, ms, kind } = leadIn;
  if (text.length === 0) return [];
  if (kind !== 'point') return [{ lines: text.map((t) => ({ text: t, atMs: 0 })), fromMs: 0, toMs: ms, point: false }];
  const lead = TUNING.leadIn;
  const fault = text[0] === 'FAULT' && text.length > 2 ? text.slice(0, 2) : [];
  const call = text.slice(fault.length);
  // The part each call line opens: the point call itself, then the GAME and SET extras.
  const parts: number[] = call.map((_, i) => [lead.pointMs, lead.gameExtraMs, lead.setExtraMs][i] ?? 0);
  const tuned = (fault.length > 0 ? lead.faultMs : 0) + parts.reduce((sum, part) => sum + part, 0);
  const k = tuned > 0 ? ms / tuned : 1;
  const callFrom = fault.length > 0 ? lead.faultMs * k : 0;
  const banners: LeadInBanner[] = [];
  if (fault.length > 0) banners.push({ lines: fault.map((t) => ({ text: t, atMs: 0 })), fromMs: 0, toMs: callFrom, point: false });
  let at = callFrom;
  const lines = call.map((t, i) => {
    const line = { text: t, atMs: at };
    at += parts[i]! * k;
    return line;
  });
  banners.push({ lines, fromMs: callFrom, toMs: ms, point: true });
  return banners;
}

/**
 * The banner to show (spec §4.3): during a serve turn's lead-in, its current banner with the lines
 * that have joined so far (`leadInBanners`); the situation (MATCH POINT, BREAK POINT, DEUCE…) as
 * PRE_SERVE begins; and the champion at match end.
 */
export function bannerFor(f: WorldFrame): Banner | null {
  if (!f.turn || !f.view) {
    const w = f.pub.winner;
    if (f.pub.status !== 'over' || w === null) return null;
    const lines = ['GAME, SET AND MATCH', f.pub.players[w].name.toUpperCase()].map((text) => ({ text, ageMs: f.overMs }));
    return { lines, ageMs: f.overMs, leftMs: null, small: false };
  }
  const d = f.turn.data;
  const v = f.view;
  if (d.kind !== 'serve') return null;
  if (v.phase === 'leadIn') {
    const τ = f.τ;
    const b = leadInBanners(d.leadIn).find((x) => τ >= x.fromMs && τ < x.toMs);
    if (!b) return null;
    const lines = b.lines.filter((l) => l.atMs <= τ).map((l) => ({ text: l.text, ageMs: τ - l.atMs }));
    return { lines, ageMs: τ - b.fromMs, leftMs: b.toMs - τ, small: false };
  }
  const age = f.τ - d.leadIn.ms;
  const text = v.phase === 'preServe' && v.prompts.length === 0 && age < SITUATION_MS ? situation(f.pub.score) : null;
  return text ? { lines: [{ text, ageMs: age }], ageMs: age, leftMs: SITUATION_MS - age, small: true } : null;
}

/** Power meters (power-meter spec §6): four 3×5 segments, 1 px apart, right of each scoreboard row; full ones pulse every 400 ms. */
const METER = { x: BOARD.x + BOARD.w + 3, dy: 2, segW: 3, segH: 5, gap: 1, pulseMs: 400 };

/** One rectangle of the HUD power meters, in buffer pixels. */
export interface MeterRect { x: number; y: number; w: number; h: number; color: string }

/**
 * Both players' meter levels as shown this frame: the committed `pub.power`, with the turn owner's
 * live level at the displayed τ (a slip empties it at once), or null in training (meter off).
 */
export function meterLevels(f: WorldFrame): [number, number] | null {
  if (f.pub.config.training !== null) return null;
  const levels: [number, number] = [f.pub.power[0], f.pub.power[1]];
  const owner = f.turn?.data.owner;
  const live = f.view?.power ?? null;
  if (owner !== undefined && live !== null) levels[owner] = live;
  return levels;
}

/**
 * The meters' rectangles, row by row: a dark backing strip, then lit segments in the insane colour
 * (alternating with its typed shade every 400 ms at a full meter, unless `steady`) and unlit ones in slate.
 */
export function meterRects(levels: [number, number], clockMs: number, steady: boolean): MeterRect[] {
  const out: MeterRect[] = [];
  const stripW = POWER_MAX * METER.segW + (POWER_MAX - 1) * METER.gap + 2;
  levels.forEach((level, row) => {
    const top = BOARD.y + 1 + row * BOARD.row + METER.dy;
    out.push({ x: METER.x - 1, y: top - 1, w: stripW, h: METER.segH + 2, color: OUTLINE });
    const pulse = level >= POWER_MAX && !steady && Math.floor(clockMs / METER.pulseMs) % 2 === 1;
    const lit = pulse ? TIER_TYPED.insane : TIER_COLOR.insane;
    for (let k = 0; k < POWER_MAX; k++) {
      const x = METER.x + k * (METER.segW + METER.gap);
      out.push({ x, y: top, w: METER.segW, h: METER.segH, color: k < level ? lit : PAL.slate });
    }
  });
  return out;
}

function drawServeClock(ctx: CanvasRenderingContext2D, seconds: number): void {
  const text = String(seconds);
  const w = Math.max(28, textWidth(text, 2) + 10);
  const x = Math.round((W - w) / 2);
  panel(ctx, x, 1, w, 20);
  rect(ctx, x + 1, 2, w - 2, 1, PAL.shadow);
  shadowText(ctx, text, x + Math.floor((w - textWidth(text, 2)) / 2), 2, seconds <= CLOCK_WARN_S ? PAL.tierYellow : PAL.cream, 2);
}

/** Widest coach text line: the panel ends left of the serve clock's slot at the top centre. */
const COACH_TEXT_W = 214;

/** Up to two word-wrapped lines of coach text on a panel in the scoreboard's place (spec §3.12). */
function drawCoach(ctx: CanvasRenderingContext2D, text: string): void {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (textWidth(next) <= COACH_TEXT_W || line === '') line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  const shown = lines.slice(0, 2);
  const w = Math.min(COACH_TEXT_W, Math.max(...shown.map((l) => textWidth(l)))) + 8;
  panel(ctx, BOARD.x, 0, w, 22);
  shown.forEach((l, i) => drawText(ctx, l, BOARD.x + 4, 1 + i * FONT.cellH, PAL.cream));
}

function drawPauseIcon(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, h } = PAUSE_ICON_RECT;
  panel(ctx, x, y, w, h);
  rect(ctx, x + 4, y + 4, 2, h - 8, PAL.cream);
  rect(ctx, x + w - 6, y + 4, 2, h - 8, PAL.cream);
}

/** A right-aligned readout on a small panel ending at x `right`. */
function readout(ctx: CanvasRenderingContext2D, text: string, right: number, y: number, alpha: number): void {
  const w = textWidth(text) + 6;
  ctx.save();
  ctx.globalAlpha = alpha;
  panel(ctx, right - w, y, w, 10);
  drawText(ctx, text, right - w + 3, y, PAL.cream);
  ctx.restore();
}

let dimLayer: Layer | null = null;

/** Darkens the frame with a cached 50 % checker of near-black (pause and focus-lost overlays). */
function dim(ctx: CanvasRenderingContext2D): void {
  if (!dimLayer) {
    dimLayer = createLayer(W, H);
    dimLayer.g.fillStyle = OUTLINE;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (checker(x, y)) dimLayer.g.fillRect(x, y, 1, 1);
  }
  ctx.drawImage(dimLayer.canvas, 0, 0);
}

/** A centred message box with a 2× title and optional 1× line. */
function message(ctx: CanvasRenderingContext2D, title: string, line: string | null, cy: number): void {
  const w = Math.max(textWidth(title, 2), line ? textWidth(line) : 0) + 20;
  const h = line ? 36 : 24;
  const x = Math.round((W - w) / 2);
  const y = Math.round(cy - h / 2);
  panel(ctx, x, y, w, h);
  rect(ctx, x + 1, y + 1, w - 2, 1, PAL.gold);
  shadowText(ctx, title, x + Math.round((w - textWidth(title, 2)) / 2), y + 4, PAL.white, 2);
  if (line) drawText(ctx, line, x + Math.round((w - textWidth(line)) / 2), y + 22, PAL.cream);
}

/**
 * The heads-up display (spec §4.3, Task 18 ruling 5): TV scoreboard, power meters, serve clock,
 * strike speed and last-word WPM, pause button, coach text, call and situation banners, and the
 * session overlays (pause dim, resume countdown, focus lost, "Connection unstable...", RTT). A
 * spectator (the attract demo behind Title and Main menu) gets none of it, whatever the display prefs.
 */
export class Hud {
  private lastWpm: number | null = null;

  /** Takes in the frame's events: the WPM of the viewer's (a spectator: anyone's) last completed word. */
  update(f: WorldFrame): void {
    for (const e of f.vm.events) {
      if (e.type === 'wordDone' && (f.local === null || e.player === f.local)) this.lastWpm = e.wpm;
    }
  }

  /** Texts of the right-hand readouts: strike speed (with its fade) and, if enabled, the last word's WPM. */
  readouts(f: WorldFrame, prefs: DisplayPrefs): { speed: { text: string; alpha: number } | null; wpm: string | null } {
    const speed = speedReadout(f);
    return {
      speed: speed ? { text: `${speed.kmh} KM/H`, alpha: speed.alpha } : null,
      wpm: prefs.showWpm && this.lastWpm !== null ? `${Math.round(this.lastWpm)} WPM` : null,
    };
  }

  /** Draws the HUD, the banners and the overlays over the world and prompt layers. */
  draw(ctx: CanvasRenderingContext2D, f: WorldFrame, prefs: DisplayPrefs, clockMs = 0): void {
    if (f.vm.viewer === 'spectator') return;
    const { overlay } = f.vm;
    if (overlay.paused || overlay.focusLost) dim(ctx);
    if (overlay.coach) drawCoach(ctx, overlay.coach);
    else {
      drawScoreboard(ctx, f.pub.score, f.pub.players, f.pub.status === 'playing' && f.pub.score.winner === null);
      const levels = meterLevels(f);
      if (levels) for (const r of meterRects(levels, clockMs, prefs.reduceEffects)) rect(ctx, r.x, r.y, r.w, r.h, r.color);
    }
    const clock = serveClockSeconds(f);
    if (clock !== null) drawServeClock(ctx, clock);
    const r = this.readouts(f, prefs);
    const right = PAUSE_ICON_RECT.x - 3;
    if (r.speed) readout(ctx, r.speed.text, right, 2, r.speed.alpha);
    if (r.wpm) readout(ctx, r.wpm, right, 12, 1);
    drawPauseIcon(ctx);
    if (overlay.unstable) message(ctx, 'CONNECTION UNSTABLE...', null, UNSTABLE_CY);
    if (overlay.rttMs !== null) readout(ctx, `RTT ${Math.round(overlay.rttMs)} MS`, W - 2, H - 12, 1);
    const banner = bannerFor(f);
    if (banner) drawBanner(ctx, banner);
    if (overlay.focusLost) message(ctx, 'CLICK TO FOCUS', "YOUR KEYS AREN'T REACHING THE GAME", 135);
    else if (overlay.countdown !== null) message(ctx, String(overlay.countdown), null, 135);
    else if (overlay.paused) message(ctx, 'PAUSED', null, 135);
  }
}
