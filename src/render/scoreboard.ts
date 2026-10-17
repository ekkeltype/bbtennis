import { BELTS } from '../core/belts';
import { currentServer, pointsDisplay, setLine, type SetCell } from '../core/scoring';
import type { PlayerInfo, ScoreState } from '../core/types';
import { contrastRatio } from './color';
import { drawText, textWidth } from './font';
import { BELT_COLOR, OUTLINE, PAL, RAMPS, type Ramp } from './palette';

/**
 * One scoreboard row: upper-case name, belt colour and, for a belt too dark to read on the panel, the
 * light 1 px inner outline of its swatch (null otherwise), the set columns as drawn (`setLine`: games
 * of completed sets, tiebreak superscripts, the Tiebreak format's points), current games and points,
 * serve dot.
 */
export interface ScoreRow {
  name: string;
  belt: string;
  beltRim: string | null;
  setCells: SetCell[];
  games: number;
  points: string;
  serving: boolean;
}

/** Belt colours under this contrast against the scoreboard panel (black, navy, brown) get a swatch rim. */
const SWATCH_MIN_CONTRAST = 3;

/** The cloth ramp of a player's belt colour (see `beltColor`), if there is one. */
function beltRamp(p: PlayerInfo): Ramp | undefined {
  const level = p.kind === 'cpu' && p.cpuLevel !== null ? BELTS[p.cpuLevel] : undefined;
  return level ? RAMPS.cloth[BELT_COLOR[level.belt]] : RAMPS.cloth[p.look.headband ?? p.look.shirt];
}

/**
 * A player's belt colour for the scoreboard swatch and remote name chips: a CPU's belt (spec §3.8),
 * a human's headband colour if they wear one, else their shirt colour.
 */
export function beltColor(p: PlayerInfo): string {
  return beltRamp(p)?.[1] ?? PAL.grey;
}

/** The highlight shade of a belt too dark to read on the scoreboard panel, for its swatch's inner outline. */
function beltRim(p: PlayerInfo): string | null {
  const ramp = beltRamp(p);
  return ramp && contrastRatio(ramp[1], PAL.night) < SWATCH_MIN_CONTRAST ? ramp[0] : null;
}

/**
 * Both scoreboard rows (spec §4.3). The serve dot marks the current server while `serving` holds,
 * by default while the score has no winner (the typing HUD also requires a match in play).
 */
export function scoreRowsFor(
  s: ScoreState,
  players: readonly [PlayerInfo, PlayerInfo],
  serving: boolean = s.winner === null,
): [ScoreRow, ScoreRow] {
  const points = pointsDisplay(s);
  const cells = setLine(s);
  const server = serving ? currentServer(s) : null;
  const row = (p: 0 | 1): ScoreRow => ({
    name: players[p].name.toUpperCase(),
    belt: beltColor(players[p]),
    beltRim: beltRim(players[p]),
    setCells: cells[p],
    games: s.games[p],
    points: points[p],
    serving: server === p,
  });
  return [row(0), row(1)];
}

/** Fills a rectangle. */
export function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** An outlined dark panel. */
export function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string = PAL.night): void {
  rect(ctx, x, y, w, h, OUTLINE);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

// Scoreboard geometry: x 2–150, two 9 px rows inside a 1 px frame (spec §4.3).
export const BOARD = { x: 2, y: 1, w: 149, h: 20, row: 9 };
const POINTS_W = 16;
const GAMES_W = 9;
const NAME_X = BOARD.x + 13;
/** A set column: 1 px before its numbers and 2 px after them (8 px for one digit). */
const SET_PAD = { left: 1, right: 2 };

/** Superscript digits (3×5), drawn 1 px right of the number they belong to, level with its top. */
const SUP_DIGITS: readonly (readonly string[])[] = [
  ['###', '#.#', '#.#', '#.#', '###'],
  ['.#.', '##.', '.#.', '.#.', '###'],
  ['###', '..#', '###', '#..', '###'],
  ['###', '..#', '.##', '..#', '###'],
  ['#.#', '#.#', '###', '..#', '..#'],
  ['###', '#..', '###', '..#', '###'],
  ['###', '#..', '###', '#.#', '###'],
  ['###', '..#', '..#', '.#.', '.#.'],
  ['###', '#.#', '###', '#.#', '###'],
  ['###', '#.#', '###', '..#', '###'],
];
const SUP_GAP = 1;

const supWidth = (n: number): number => String(n).length * 4 - 1;

function drawSup(ctx: CanvasRenderingContext2D, n: number, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  [...String(n)].forEach((d, i) => {
    SUP_DIGITS[Number(d)]?.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === '#') ctx.fillRect(x + 4 * i + dx, y + dy, 1, 1);
    });
  });
}

/** A set column: its left edge and the x its numbers end at (right-aligned; a superscript follows). */
interface SetColumn { x: number; numbersEnd: number }

/** The set columns of both rows, laid right to left so the last one ends at `right`. */
function setColumns(rows: [ScoreRow, ScoreRow], right: number): SetColumn[] {
  const cols: SetColumn[] = [];
  let x = right;
  for (let k = rows[0].setCells.length - 1; k >= 0; k--) {
    const cells = rows.flatMap((r) => r.setCells[k] ?? []);
    const numbers = Math.max(...cells.map((c) => textWidth(String(c.value))));
    const sups = Math.max(0, ...cells.map((c) => (c.sup === null ? 0 : SUP_GAP + supWidth(c.sup))));
    x -= SET_PAD.left + numbers + sups + SET_PAD.right;
    cols.unshift({ x, numbersEnd: x + SET_PAD.left + numbers });
  }
  return cols;
}

/** `name` cut short (trailing spaces dropped) to at most `maxW` px. */
function fitName(name: string, maxW: number): string {
  let out = name;
  while (out.length > 0 && textWidth(out) > maxW) out = out.slice(0, -1).trimEnd();
  return out;
}

/** Games and points show until a Tiebreak-format match is decided; then its final tiebreak column is the whole score. */
function showsGameColumns(s: ScoreState): boolean {
  return !(s.format === 'tiebreak' && s.winner !== null);
}

/** Draws the TV scoreboard panel (spec §4.3) for `score`; `serving` as in `scoreRowsFor`. */
export function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  score: ScoreState,
  players: readonly [PlayerInfo, PlayerInfo],
  serving: boolean = score.winner === null,
): void {
  const rows = scoreRowsFor(score, players, serving);
  const right = BOARD.x + BOARD.w - 1;
  const pointsX = right - POINTS_W;
  const gamesX = pointsX - GAMES_W;
  const gameColumns = showsGameColumns(score);
  const setsRight = gameColumns ? gamesX : right;
  const cols = setColumns(rows, setsRight);
  const nameW = (cols[0]?.x ?? setsRight) - 1 - NAME_X;
  panel(ctx, BOARD.x, BOARD.y, BOARD.w, BOARD.h);
  if (gameColumns) rect(ctx, pointsX, BOARD.y + 1, POINTS_W, BOARD.h - 2, PAL.gold);
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
    rect(ctx, BOARD.x + 7, top + 2, 3, 5, r.beltRim ?? r.belt);
    if (r.beltRim !== null) rect(ctx, BOARD.x + 8, top + 3, 1, 3, r.belt);
    drawText(ctx, fitName(r.name, nameW), NAME_X, top, PAL.cream);
    r.setCells.forEach((c, k) => {
      const col = cols[k]!;
      const text = String(c.value);
      drawText(ctx, text, col.numbersEnd - textWidth(text), top, PAL.silver);
      // Level with the top of the digits (glyph row 1).
      if (c.sup !== null) drawSup(ctx, c.sup, col.numbersEnd + SUP_GAP, top + 1, PAL.silver);
    });
    if (!gameColumns) return;
    centred(String(r.games), gamesX, GAMES_W, top, PAL.white);
    centred(r.points, pointsX, POINTS_W, top, OUTLINE);
  });
}

