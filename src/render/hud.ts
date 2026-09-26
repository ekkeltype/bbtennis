import { CPU_LEVELS } from '../core/cpu';
import { currentServer, pointsDisplay, situation } from '../core/scoring';
import { TUNING } from '../core/tuning';
import type { DisplayPrefs, LeadIn, PlayerInfo, PublicState } from '../core/types';
import { clamp, easeOutQuad } from '../core/util';
import { checker } from './court';
import { drawText, FONT, textWidth } from './font';
import { BELT_COLOR, OUTLINE, PAL, RAMPS } from './palette';
import { H, W } from './projection';
import { createLayer, type Layer } from './screen';
import type { WorldFrame } from './world';

/** The on-screen pause button (spec §4.3), top-right in the HUD band, in 480×270 buffer pixels. */
export const PAUSE_ICON_RECT: Readonly<{ x: number; y: number; w: number; h: number }> = { x: 462, y: 3, w: 15, h: 15 };

/** One scoreboard row: upper-case name, belt colour, games of completed sets, current games and points, serve dot. */
export interface ScoreRow { name: string; belt: string; sets: number[]; games: number; points: string; serving: boolean }

/** A banner line and the time since it appeared (a line can join a banner that is already up). */
export interface BannerLine { text: string; ageMs: number }

/** A banner: its lines, time since it appeared, time left (null = stays) and whether it is the small kind. */
export interface Banner { lines: BannerLine[]; ageMs: number; leftMs: number | null; small: boolean }

/** One banner of a lead-in (lead-in τ): its lines with the time each joins, its span, and whether it is the point call. */
export interface LeadInBanner { lines: { text: string; atMs: number }[]; fromMs: number; toMs: number; point: boolean }

/** How long the speed readout stays after a strike, then fades. */
const SPEED_SHOW_MS = 2000;
const SPEED_FADE_MS = 500;
/** The situation banner (MATCH POINT, DEUCE…) at the start of PRE_SERVE. */
const SITUATION_MS = 1500;
/** Banner slide-in (the banner and each line joining it) and fade-out. */
const BANNER_IN_MS = 180;
const BANNER_OUT_MS = 250;
/** Top row of the call banners: a one-line banner is centred on y 96; longer ones grow downward from here. */
const BANNER_TOP = 83;
const BANNER_LINE_H = 18;
/** The serve clock turns yellow (never red) for its last seconds. */
const CLOCK_WARN_S = 5;

/**
 * A player's belt colour for the scoreboard swatch and remote name chips: a CPU's belt (spec §3.8),
 * a human's headband colour if they wear one, else their shirt colour.
 */
export function beltColor(p: PlayerInfo): string {
  const level = p.kind === 'cpu' && p.cpuLevel !== null ? CPU_LEVELS[p.cpuLevel] : undefined;
  const ramp = level ? RAMPS.cloth[BELT_COLOR[level.belt]] : RAMPS.cloth[p.look.headband ?? p.look.shirt];
  return ramp?.[1] ?? PAL.grey;
}

/** Both scoreboard rows (spec §4.3); the serve dot marks the current server while the match is on. */
export function scoreRows(pub: PublicState): [ScoreRow, ScoreRow] {
  const s = pub.score;
  const points = pointsDisplay(s);
  const server = pub.status === 'playing' && s.winner === null ? currentServer(s) : null;
  const row = (p: 0 | 1): ScoreRow => ({
    name: pub.players[p].name.toUpperCase(),
    belt: beltColor(pub.players[p]),
    sets: s.setGames.map((g) => g[p]),
    games: s.games[p],
    points: points[p],
    serving: server === p,
  });
  return [row(0), row(1)];
}

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

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** An outlined dark panel. */
function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string = PAL.night): void {
  rect(ctx, x, y, w, h, OUTLINE);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

/** Text with a one-glyph-pixel dark drop shadow. */
function shadowText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, scale: 1 | 2 = 1): void {
  drawText(ctx, s, x + scale, y + scale, OUTLINE, scale);
  drawText(ctx, s, x, y, color, scale);
}

// Scoreboard geometry: x 2–150, two 9 px rows inside a 1 px frame (spec §4.3).
const BOARD = { x: 2, y: 1, w: 149, h: 20, row: 9 };
const POINTS_W = 16;
const GAMES_W = 9;
const SET_W = 8;

function drawScoreboard(ctx: CanvasRenderingContext2D, pub: PublicState): void {
  const rows = scoreRows(pub);
  const right = BOARD.x + BOARD.w - 1;
  const pointsX = right - POINTS_W;
  const gamesX = pointsX - GAMES_W;
  panel(ctx, BOARD.x, BOARD.y, BOARD.w, BOARD.h);
  rect(ctx, pointsX, BOARD.y + 1, POINTS_W, BOARD.h - 2, PAL.gold);
  rect(ctx, BOARD.x + 1, BOARD.y + BOARD.row + 1, BOARD.w - 2, 1, PAL.shadow);
  const centred = (s: string, x: number, w: number, y: number, color: string): void =>
    drawText(ctx, s, x + Math.floor((w - textWidth(s)) / 2), y, color);
  rows.forEach((r, i) => {
    const top = BOARD.y + 1 + i * BOARD.row;
    if (r.serving) {
      rect(ctx, BOARD.x + 2, top + 3, 3, 3, PAL.ball);
      rect(ctx, BOARD.x + 2, top + 5, 3, 1, PAL.ballShade);
    }
    rect(ctx, BOARD.x + 6, top + 1, 5, 7, PAL.grey);
    rect(ctx, BOARD.x + 7, top + 2, 3, 5, r.belt);
    drawText(ctx, r.name, BOARD.x + 13, top, PAL.cream);
    r.sets.forEach((g, k) => centred(String(g), gamesX - SET_W * (r.sets.length - k), SET_W, top, PAL.silver));
    centred(String(r.games), gamesX, GAMES_W, top, PAL.white);
    centred(r.points, pointsX, POINTS_W, top, OUTLINE);
  });
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

/** Share of the screen width that something `ageMs` into its slide-in still lies to the left. */
const slideLeft = (ageMs: number): number => 1 - easeOutQuad(clamp(ageMs / BANNER_IN_MS, 0, 1));

function drawBanner(ctx: CanvasRenderingContext2D, b: Banner): void {
  const alpha = b.leftMs === null ? 1 : clamp(b.leftMs / BANNER_OUT_MS, 0, 1);
  if (alpha <= 0) return;
  const h = b.lines.length * BANNER_LINE_H + 8;
  const widest = Math.max(...b.lines.map((l) => textWidth(l.text, 2)));
  const w = b.small ? widest + 24 : W;
  const x = Math.round((W - w) / 2 - slideLeft(b.ageMs) * W);
  ctx.save();
  ctx.globalAlpha = alpha;
  rect(ctx, x, BANNER_TOP, w, h, OUTLINE);
  rect(ctx, x, BANNER_TOP + 1, w, 1, PAL.gold);
  rect(ctx, x, BANNER_TOP + 2, w, h - 4, PAL.night);
  rect(ctx, x, BANNER_TOP + h - 2, w, 1, PAL.gold);
  b.lines.forEach((line, i) => {
    const tx = Math.round((W - textWidth(line.text, 2)) / 2 - slideLeft(line.ageMs) * W);
    shadowText(ctx, line.text, tx, BANNER_TOP + 3 + i * BANNER_LINE_H, i === 0 ? PAL.white : PAL.gold, 2);
  });
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
 * The heads-up display (spec §4.3, Task 18 ruling 5): TV scoreboard, serve clock, strike speed and
 * last-word WPM, pause button, coach text, call and situation banners, and the session overlays
 * (pause dim, resume countdown, focus lost, "Connection unstable...", RTT). A spectator (the attract
 * demo behind Title and Main menu) gets none of it, whatever the display prefs.
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
  draw(ctx: CanvasRenderingContext2D, f: WorldFrame, prefs: DisplayPrefs): void {
    if (f.vm.viewer === 'spectator') return;
    const { overlay } = f.vm;
    if (overlay.paused || overlay.focusLost) dim(ctx);
    if (overlay.coach) drawCoach(ctx, overlay.coach);
    else drawScoreboard(ctx, f.pub);
    const clock = serveClockSeconds(f);
    if (clock !== null) drawServeClock(ctx, clock);
    const r = this.readouts(f, prefs);
    const right = PAUSE_ICON_RECT.x - 3;
    if (r.speed) readout(ctx, r.speed.text, right, 2, r.speed.alpha);
    if (r.wpm) readout(ctx, r.wpm, right, 12, 1);
    drawPauseIcon(ctx);
    if (overlay.unstable) message(ctx, 'CONNECTION UNSTABLE...', null, 40);
    if (overlay.rttMs !== null) readout(ctx, `RTT ${Math.round(overlay.rttMs)} MS`, W - 2, H - 12, 1);
    const banner = bannerFor(f);
    if (banner) drawBanner(ctx, banner);
    if (overlay.focusLost) message(ctx, 'CLICK TO FOCUS', "YOUR KEYS AREN'T REACHING THE GAME", 135);
    else if (overlay.countdown !== null) message(ctx, String(overlay.countdown), null, 135);
    else if (overlay.paused) message(ctx, 'PAUSED', null, 135);
  }
}
