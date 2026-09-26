import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import { createScore } from '../../src/core/scoring';
import { createTurn, startTurn, turnClock, turnInput } from '../../src/core/turn';
import { TUNING } from '../../src/core/tuning';
import type {
  DisplayPrefs,
  GameEvent,
  Look,
  MatchState,
  PlayerId,
  PlayerStats,
  ScoreState,
  TurnState,
  ViewModel,
} from '../../src/core/types';
import { contrastRatio, relativeLuminance } from '../../src/render/color';
import { BELT_COLOR, PAL, RAMPS } from '../../src/render/palette';
import {
  Hud,
  PAUSE_ICON_RECT,
  bannerFor,
  beltColor,
  leadInBanners,
  scoreRows,
  serveClockSeconds,
  speedReadout,
  type Banner,
} from '../../src/render/hud';
import { worldFrame } from '../../src/render/world';
import { RALLY_IN, flight, opt, returnData, serveData } from '../core/turnFixtures';

const LOOK: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 6, shorts: 0, headband: null, racket: 0 };
const STATS: PlayerStats = {
  pointsWon: 0, aces: 0, doubleFaults: 0, winners: 0, errors: 0, wordsCompleted: 0,
  intervalSum: 0, typingMs: 0, topWpm: 0, correctKeys: 0, wrongKeys: 0, fastestServeKmh: 0,
};
const PREFS: DisplayPrefs = { largeWords: false, reduceEffects: false, showWpm: true };

function matchState(turn: TurnState | null, lastTurn: TurnState | null = null, over: Partial<MatchState> = {}): MatchState {
  return {
    v: 1,
    config: { format: 'bo3', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: [
      { name: 'Alexandra', look: LOOK, kind: 'human', cpuLevel: null },
      { name: 'Kai', look: LOOK, kind: 'cpu', cpuLevel: 7 },
    ],
    score: createScore('bo3', 'advantage', 0),
    stats: [{ ...STATS }, { ...STATS }],
    turn,
    lastTurn,
    rallyStrikes: 0,
    longestRally: 0,
    pointNo: 1,
    status: 'playing',
    winner: null,
    forfeitBy: null,
    nextTurnId: 20,
    nextPromptBase: 100,
    rng: null,
    picker: null,
    ...over,
  };
}

function view(pub: MatchState, turnτ: number, viewer: PlayerId | 'spectator' = 0, events: GameEvent[] = []): ViewModel {
  return {
    pub,
    viewer,
    turnτ,
    liveTurn: null,
    events,
    overlay: {
      paused: false, countdown: null, coach: null, wait: false, unstable: false,
      hintSpace: false, hintFirstLetter: false, focusLost: false, rttMs: null,
    },
  };
}

function serveTurn(over: Parameters<typeof serveData>[0] = {}): TurnState {
  const t = createTurn(serveData(over));
  startTurn(t);
  return t;
}

describe('PAUSE_ICON_RECT', () => {
  it('sits in the top-right corner inside the HUD band', () => {
    const r = PAUSE_ICON_RECT;
    expect(r.x).toBeGreaterThanOrEqual(440);
    expect(r.x + r.w).toBeLessThanOrEqual(480);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(22);
    expect(r.w).toBeGreaterThanOrEqual(12);
    expect(r.h).toBeGreaterThanOrEqual(12);
  });
});

describe('scoreboard', () => {
  it('lists upper-case names, completed sets, games, TV points and the serve dot', () => {
    const score: ScoreState = {
      ...createScore('bo3', 'advantage', 0),
      setGames: [[4, 2]],
      games: [1, 3],
      points: [3, 4],
      setsWon: [1, 0],
      gameServer: 1,
    };
    const rows = scoreRows(matchState(null, null, { score }));
    expect(rows.map((r) => r.name)).toEqual(['ALEXANDRA', 'KAI']);
    expect(rows.map((r) => r.sets)).toEqual([[4], [2]]);
    expect(rows.map((r) => r.games)).toEqual([1, 3]);
    expect(rows.map((r) => r.points)).toEqual(['', 'AD']);
    expect(rows.map((r) => r.serving)).toEqual([false, true]);
  });

  it("shows a set won in a tiebreak with the loser's points as a superscript beside the winner's games", () => {
    const score: ScoreState = {
      ...createScore('bo3', 'advantage', 0),
      setGames: [[4, 5], [5, 4]],
      setTiebreaks: [[3, 7], [7, 5]],
      games: [1, 0],
      setsWon: [1, 1],
    };
    const rows = scoreRows(matchState(null, null, { score }));
    expect(rows.map((r) => r.sets)).toEqual([[4, 5], [5, 4]]);
    expect(rows.map((r) => r.setCells)).toEqual([
      [{ value: 4, sup: null }, { value: 5, sup: 5 }],
      [{ value: 5, sup: 3 }, { value: 4, sup: null }],
    ]);
  });

  it('shows a finished Tiebreak-format match by its final tiebreak points instead of a 1-0 set column', () => {
    const score: ScoreState = {
      ...createScore('tiebreak', 'advantage', 0),
      setGames: [[1, 0]],
      setTiebreaks: [[7, 5]],
      inTiebreak: false,
      setsWon: [1, 0],
      winner: 0,
    };
    const rows = scoreRows(matchState(null, null, { score, status: 'over', winner: 0 }));
    expect(rows.map((r) => r.setCells)).toEqual([[{ value: 7, sup: null }], [{ value: 5, sup: null }]]);
  });

  it('shows no serve dot once the match is over', () => {
    const rows = scoreRows(matchState(null, null, { status: 'over', winner: 0 }));
    expect(rows.map((r) => r.serving)).toEqual([false, false]);
  });

  it('colours a CPU by its belt and a human by headband, else shirt', () => {
    const cpu = { name: 'Kai', look: LOOK, kind: 'cpu' as const, cpuLevel: 7 };
    expect(beltColor(cpu)).toBe(RAMPS.cloth[BELT_COLOR[CPU_LEVELS[7]!.belt]]![1]);
    const human = { name: 'Al', look: LOOK, kind: 'human' as const, cpuLevel: null };
    expect(beltColor(human)).toBe(RAMPS.cloth[6]![1]);
    expect(beltColor({ ...human, look: { ...LOOK, headband: 9 } })).toBe(RAMPS.cloth[9]![1]);
  });
});

describe('serve clock', () => {
  it('counts whole seconds down during PRE_SERVE, TOSS and CATCH only', () => {
    const t = serveTurn();
    const at = (τ: number): number | null => {
      turnClock(t, τ);
      return serveClockSeconds(worldFrame(view(matchState(t), τ)));
    };
    expect(at(1000)).toBeNull(); // lead-in
    expect(at(2500)).toBe(30);
    expect(at(2501)).toBe(30);
    expect(at(3600)).toBe(29);
    turnInput(t, 'toss', 4000);
    expect(at(4200)).toBe(29);
    expect(at(8000)).toBe(25); // caught at 8000, still counting
  });

  it('is hidden in return turns and without a serve clock (training)', () => {
    const t = serveTurn({ serveClockMs: null });
    turnClock(t, 3000);
    expect(serveClockSeconds(worldFrame(view(matchState(t), 3000)))).toBeNull();
    const r = createTurn(returnData());
    startTurn(r);
    expect(serveClockSeconds(worldFrame(view(matchState(r), 100)))).toBeNull();
  });
});

describe('speed readout', () => {
  /** A serve turn struck at 3000 and the return turn it starts. */
  function afterStrike(): { serve: TurnState; ret: TurnState; kmh: number } {
    const serve = serveTurn();
    turnInput(serve, 'toss', 2600);
    for (const [i, ch] of [...'ball'].entries()) turnInput(serve, ch, 2800 + i * 100);
    const o = serve.outcome;
    if (o?.kind !== 'strike') throw new Error('expected a strike');
    const ret = createTurn(
      returnData({ turnId: 8, incoming: o.strike.flight, chase: opt('ball'), isServeReturn: true, n: 0 }),
    );
    startTurn(ret);
    return { serve, ret, kmh: o.strike.kmh };
  }

  it('shows the last strike speed for 2 s, then fades it out', () => {
    const { serve, ret, kmh } = afterStrike();
    const at = (τ: number): ReturnType<typeof speedReadout> => speedReadout(worldFrame(view(matchState(ret, serve), τ)));
    expect(at(0)).toEqual({ kmh, alpha: 1 });
    expect(at(1999)).toEqual({ kmh, alpha: 1 });
    expect(at(2250)?.alpha).toBeCloseTo(0.5, 6);
    expect(at(2500)).toBeNull();
    expect(kmh).toBeGreaterThan(100);
  });

  it('is absent in serve turns', () => {
    const t = serveTurn();
    turnClock(t, 3000);
    expect(speedReadout(worldFrame(view(matchState(t), 3000)))).toBeNull();
  });
});

describe('leadInBanners (R30)', () => {
  const { faultMs, pointMs, gameExtraMs, setExtraMs } = TUNING.leadIn;
  const line = (text: string, atMs: number): { text: string; atMs: number } => ({ text, atMs });

  it('plays a double fault as the FAULT call for faultMs, then DOUBLE FAULT with its GAME line joining later', () => {
    const ms = faultMs + pointMs + gameExtraMs;
    const banners = leadInBanners({ kind: 'point', ms, text: ['FAULT', 'TIME VIOLATION', 'DOUBLE FAULT', 'GAME KAI'] });
    expect(banners).toEqual([
      { lines: [line('FAULT', 0), line('TIME VIOLATION', 0)], fromMs: 0, toMs: faultMs, point: false },
      { lines: [line('DOUBLE FAULT', faultMs), line('GAME KAI', faultMs + pointMs)], fromMs: faultMs, toMs: ms, point: true },
    ]);
  });

  it('adds the GAME and SET lines to a point call in order as their parts begin', () => {
    const ms = pointMs + gameExtraMs + setExtraMs;
    expect(leadInBanners({ kind: 'point', ms, text: ['OUT', 'GAME KAI', 'SET KAI'] })).toEqual([
      {
        lines: [line('OUT', 0), line('GAME KAI', pointMs), line('SET KAI', pointMs + gameExtraMs)],
        fromMs: 0,
        toMs: ms,
        point: true,
      },
    ]);
    expect(leadInBanners({ kind: 'point', ms: pointMs, text: ['ACE!'] })).toEqual([
      { lines: [line('ACE!', 0)], fromMs: 0, toMs: pointMs, point: true },
    ]);
  });

  it('shows an intro or a first-serve fault as one banner for the whole lead-in', () => {
    expect(leadInBanners({ kind: 'fault', ms: faultMs, text: ['FAULT', 'NET'] })).toEqual([
      { lines: [line('FAULT', 0), line('NET', 0)], fromMs: 0, toMs: faultMs, point: false },
    ]);
    expect(leadInBanners({ kind: 'intro', ms: 2500, text: ['ALEX TO SERVE'] })).toEqual([
      { lines: [line('ALEX TO SERVE', 0)], fromMs: 0, toMs: 2500, point: false },
    ]);
    expect(leadInBanners({ kind: 'none', ms: 0, text: [] })).toEqual([]);
  });

  it('scales every part to fill a lead-in whose length differs from the tuned one', () => {
    const tuned = faultMs + pointMs;
    const [fault, call] = leadInBanners({ kind: 'point', ms: tuned / 2, text: ['FAULT', 'NET', 'DOUBLE FAULT'] });
    expect(fault).toMatchObject({ fromMs: 0, toMs: faultMs / 2 });
    expect(call).toMatchObject({ fromMs: faultMs / 2, toMs: tuned / 2, lines: [line('DOUBLE FAULT', faultMs / 2)] });
  });
});

describe('banners', () => {
  const { faultMs, pointMs, gameExtraMs } = TUNING.leadIn;
  const texts = (b: Banner | null): string[] | undefined => b?.lines.map((l) => l.text);

  it('shows a double fault\'s FAULT call first, then DOUBLE FAULT, each sliding in and fading out on its own', () => {
    const ms = faultMs + pointMs + gameExtraMs;
    const t = serveTurn({ leadIn: { kind: 'point', ms, text: ['FAULT', 'BALL DROPPED', 'DOUBLE FAULT', 'GAME KAI'] } });
    const at = (τ: number): Banner | null => bannerFor(worldFrame(view(matchState(t), τ)));
    expect(at(0)).toMatchObject({ ageMs: 0, leftMs: faultMs, small: false });
    expect(texts(at(0))).toEqual(['FAULT', 'BALL DROPPED']);
    expect(texts(at(faultMs - 1))).toEqual(['FAULT', 'BALL DROPPED']);
    expect(at(faultMs - 1)?.leftMs).toBe(1);
    expect(at(faultMs)).toMatchObject({ lines: [{ text: 'DOUBLE FAULT', ageMs: 0 }], ageMs: 0, leftMs: pointMs + gameExtraMs });
    expect(texts(at(faultMs + pointMs - 1))).toEqual(['DOUBLE FAULT']);
    expect(at(faultMs + pointMs + 100)).toMatchObject({
      lines: [
        { text: 'DOUBLE FAULT', ageMs: pointMs + 100 },
        { text: 'GAME KAI', ageMs: 100 },
      ],
      ageMs: pointMs + 100,
      leftMs: gameExtraMs - 100,
    });
    turnClock(t, ms + 100);
    expect(at(ms + 100)).toBeNull();
  });

  it('announces the situation when PRE_SERVE begins', () => {
    const score: ScoreState = { ...createScore('bo3', 'advantage', 0), points: [2, 3] };
    const t = serveTurn({ side: 'ad' });
    turnClock(t, 2600);
    const pub = matchState(t, null, { score });
    const b = bannerFor(worldFrame(view(pub, 2600)));
    expect(b).toMatchObject({ lines: [{ text: 'BREAK POINT', ageMs: 100 }], small: true });
    turnClock(t, 4500);
    expect(bannerFor(worldFrame(view(pub, 4500)))).toBeNull();
  });

  it('crowns the match winner once the match is over', () => {
    const last = createTurn(returnData({ incoming: flight() }));
    startTurn(last);
    turnClock(last, RALLY_IN.T + RALLY_IN.grace);
    const pub = matchState(null, last, { status: 'over', winner: 1 });
    const b = bannerFor(worldFrame(view(pub, 0), 500));
    expect(texts(b)).toEqual(['GAME, SET AND MATCH', 'KAI']);
    expect(b?.ageMs).toBe(500);
  });
});

/** A box on the frame: top-left corner and size. */
interface Box { x: number; y: number; w: number; h: number }

/**
 * A 2D context stand-in that records every filled rectangle with its fill style, where every image
 * (a glyph from the font atlas) lands, and the name of every drawing call.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  rects: (Box & { style: string })[];
  images: Box[];
  calls: string[];
} {
  const rects: (Box & { style: string })[] = [];
  const images: Box[] = [];
  const calls: string[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push('fillRect');
      rects.push({ x, y, w, h, style: String(state.fillStyle) });
    },
    drawImage(...args: number[]) {
      calls.push('drawImage');
      if (args.length === 9) images.push({ x: args[5]!, y: args[6]!, w: args[7]!, h: args[8]! });
    },
  };
  const ctx = new Proxy(state, {
    get: (t, key: string) => (key in t ? t[key] : () => calls.push(key)),
    set: (t, key: string, value) => {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, rects, images, calls };
}

/** An offscreen canvas for the font atlas whose context accepts and ignores every call. */
class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): CanvasRenderingContext2D {
    return recordingContext().ctx;
  }
}

describe('Hud.draw', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
  afterEach(() => vi.unstubAllGlobals());

  /** True if the scoreboard's outlined panel (x 2–150, y 1–20) was painted. */
  const scoreboardPainted = (rects: { x: number; y: number; w: number; h: number }[]): boolean =>
    rects.some((r) => r.x === 2 && r.y === 1 && r.w === 149 && r.h === 20);

  it('paints the TV scoreboard at the top left', () => {
    const t = serveTurn();
    const { ctx, rects } = recordingContext();
    new Hud().draw(ctx, worldFrame(view(matchState(t), 100)), PREFS);
    expect(scoreboardPainted(rects)).toBe(true);
  });

  /** The HUD of a frame with no turn running, over `over` (score, players, status), as player 0 sees it. */
  function drawBoard(over: Partial<MatchState>): ReturnType<typeof recordingContext> {
    const rec = recordingContext();
    new Hud().draw(rec.ctx, worldFrame(view(matchState(null, null, over), 0)), PREFS);
    return rec;
  }

  /** Top row of scoreboard row `i`: its name, set, games and points glyphs start there. */
  const rowTop = (i: 0 | 1): number => 2 + 9 * i;

  /** Every pixel the rectangles cover, as "x,y" keys. */
  const pixelsOf = (boxes: Box[]): Set<string> => {
    const out = new Set<string>();
    for (const r of boxes) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.add(`${x},${y}`);
    return out;
  };

  it("draws the tiebreak loser's points as a small 3×5 superscript digit beside the winner's games, top-aligned with them", () => {
    const score: ScoreState = {
      ...createScore('full', 'advantage', 0),
      setGames: [[7, 6]],
      setTiebreaks: [[7, 5]],
      setsWon: [1, 0],
      winner: 0,
    };
    const { rects, images } = drawBoard({ score, status: 'over', winner: 0 });
    const pixels = pixelsOf(rects.filter((r) => r.style === PAL.silver));
    const x0 = Math.min(...[...pixels].map((p) => Number(p.split(',')[0])));
    const want = new Set<string>();
    ['###', '#..', '###', '..#', '###'].forEach((row, dy) =>
      [...row].forEach((c, dx) => {
        if (c === '#') want.add(`${x0 + dx},${rowTop(0) + 1 + dy}`);
      }),
    );
    expect(pixels).toEqual(want);
    // One px right of the winner's 7 (row 0), left of the games column (x 125).
    const seven = images.filter((b) => b.y === rowTop(0) && b.x + b.w + 1 === x0);
    expect(seven).toHaveLength(1);
    expect(x0 + 3).toBeLessThan(125);
  });

  it('keeps the glyphs of a row apart, cutting a long name short before wide set columns', () => {
    const score: ScoreState = {
      ...createScore('bo3', 'advantage', 0),
      setGames: [[5, 4], [4, 5], [5, 4]],
      setTiebreaks: [[12, 10], [10, 12], [13, 11]],
      setsWon: [2, 1],
      winner: 0,
    };
    const players = matchState(null).players;
    const long = { ...players[0], name: 'Alexandra Li' };
    const { rects, images } = drawBoard({ score, status: 'over', winner: 0, players: [long, players[1]] });
    for (const i of [0, 1] as const) {
      const inRow = (b: Box): boolean => b.y >= rowTop(i) && b.y < rowTop(i) + 9;
      const glyphs = images.filter(inRow);
      const sup = pixelsOf(rects.filter((r) => r.style === PAL.silver && inRow(r)));
      // The name's glyphs, then 3 sets, games and points: 'KAI' in full, 'ALEXANDRA LI' cut to 'ALEXANDRA'.
      expect(glyphs.length - 5).toBe(i === 0 ? 'ALEXANDRA'.length : 'KAI'.length);
      expect(sup.size).toBeGreaterThan(0);
      const sorted = [...glyphs].sort((a, b) => a.x - b.x);
      for (let k = 1; k < sorted.length; k++) {
        const [a, b] = [sorted[k - 1]!, sorted[k]!];
        expect(b.x, `row ${i}: glyph at ${b.x} after ${a.x}+${a.w}`).toBeGreaterThan(a.x + a.w);
      }
      // No superscript pixel lies on a glyph cell or right next to one.
      for (const key of sup) {
        const [x, y] = key.split(',').map(Number) as [number, number];
        for (const g of glyphs) expect(x < g.x - 1 || x > g.x + g.w || y < g.y || y >= g.y + g.h, `row ${i}: ${key}`).toBe(true);
      }
      expect(Math.max(...glyphs.map((b) => b.x + b.w))).toBeLessThanOrEqual(150);
    }
  });

  /** The glyphs drawn in scoreboard row `i` (x 2–150). */
  const rowGlyphs = (images: Box[], i: 0 | 1): Box[] => images.filter((b) => b.y === rowTop(i) && b.x <= 150);
  /** True if the gold points column (x 134–149) was painted. */
  const pointsColumnPainted = (rects: (Box & { style: string })[]): boolean =>
    rects.some((r) => r.style === PAL.gold && r.x === 134 && r.y === 2);

  it('ends a Tiebreak-format match on its final tiebreak points alone, without the zeroed games and points columns', () => {
    const score: ScoreState = {
      ...createScore('tiebreak', 'advantage', 0),
      setGames: [[1, 0]],
      setTiebreaks: [[7, 5]],
      inTiebreak: false,
      setsWon: [1, 0],
      winner: 0,
    };
    const { rects, images } = drawBoard({ score, status: 'over', winner: 0 });
    expect(pointsColumnPainted(rects)).toBe(false);
    for (const i of [0, 1] as const) {
      const glyphs = rowGlyphs(images, i);
      // The name, then the final tiebreak points (7 / 5), right-aligned 2 px inside the frame.
      expect(glyphs).toHaveLength((i === 0 ? 'ALEXANDRA' : 'KAI').length + 1);
      expect(Math.max(...glyphs.map((b) => b.x + b.w))).toBe(148);
    }
  });

  it('keeps the games and points columns while a Tiebreak-format match is on, after a forfeit, and at the end of other formats', () => {
    const live: ScoreState = { ...createScore('tiebreak', 'advantage', 0), points: [3, 2] };
    const full: ScoreState = { ...createScore('full', 'advantage', 0), setGames: [[6, 3]], setTiebreaks: [null], setsWon: [1, 0], winner: 0 };
    const boards: Partial<MatchState>[] = [
      { score: live },
      { score: live, status: 'over', winner: 1, forfeitBy: 0 },
      { score: full, status: 'over', winner: 0 },
    ];
    for (const over of boards) {
      const { rects, images } = drawBoard(over);
      expect(pointsColumnPainted(rects)).toBe(true);
      const sets = over.score!.setGames.length;
      // The name, the set columns, then games and points.
      for (const i of [0, 1] as const) expect(rowGlyphs(images, i)).toHaveLength((i === 0 ? 'ALEXANDRA' : 'KAI').length + sets + 2);
    }
  });

  it("gives a dark belt swatch (black, navy, brown) a light 1 px inner outline in its highlight shade, so it never reads as an empty slot", () => {
    /** The swatch of row `i` as painted, in order: the 5×7 frame, then what is painted inside it. */
    const swatch = (players: MatchState['players'], i: 0 | 1): (Box & { style: string })[] =>
      drawBoard({ players }).rects.filter((r) => r.x >= 8 && r.x + r.w <= 13 && r.y >= rowTop(i) + 1 && r.y + r.h <= rowTop(i) + 8);
    const human = (shirt: number): MatchState['players'][0] => ({ name: 'Al', look: { ...LOOK, shirt }, kind: 'human', cpuLevel: null });
    const cpu = (cpuLevel: number): MatchState['players'][1] => ({ name: 'Kai', look: LOOK, kind: 'cpu', cpuLevel });
    const frame = (i: 0 | 1): Box & { style: string } => ({ x: 8, y: rowTop(i) + 1, w: 5, h: 7, style: PAL.grey });
    const plain = (i: 0 | 1, ramp: readonly string[]): (Box & { style: string })[] => [frame(i), { x: 9, y: rowTop(i) + 2, w: 3, h: 5, style: ramp[1]! }];
    const rimmed = (i: 0 | 1, ramp: readonly string[]): (Box & { style: string })[] => [
      frame(i),
      { x: 9, y: rowTop(i) + 2, w: 3, h: 5, style: ramp[0]! },
      { x: 10, y: rowTop(i) + 3, w: 1, h: 3, style: ramp[1]! },
    ];
    const cloth = (i: number): readonly string[] => RAMPS.cloth[i]!;
    expect([CPU_LEVELS[12]!.belt, CPU_LEVELS[0]!.belt]).toEqual(['black', 'white']);
    expect(swatch([human(7), cpu(12)], 1)).toEqual(rimmed(1, cloth(BELT_COLOR.black)));
    expect(swatch([human(7), cpu(12)], 0)).toEqual(rimmed(0, cloth(7)));
    expect(swatch([human(6), cpu(0)], 1)).toEqual(plain(1, cloth(BELT_COLOR.white)));
    // Every cloth colour: under 3:1 against the panel it gets the inner outline (brown, black, navy).
    const dark: number[] = [];
    RAMPS.cloth.forEach((ramp, shirt) => {
      const isDark = contrastRatio(ramp[1], PAL.night) < 3;
      if (isDark) dark.push(shirt);
      expect(swatch([human(shirt), cpu(0)], 0), `cloth ${shirt}`).toEqual(isDark ? rimmed(0, ramp) : plain(0, ramp));
      if (isDark) expect(relativeLuminance(ramp[0])).toBeGreaterThan(relativeLuminance(ramp[1]));
    });
    expect(dark).toEqual([BELT_COLOR.brown, BELT_COLOR.black, 7]);
  });

  it('replaces the scoreboard with the coach text in the HUD band (spec §3.12)', () => {
    const t = serveTurn({ serveClockMs: null });
    turnClock(t, 3000);
    const vm = view(matchState(t), 3000);
    const { ctx, rects } = recordingContext();
    new Hud().draw(ctx, worldFrame({ ...vm, overlay: { ...vm.overlay, coach: 'Press SPACE to toss the ball' } }), PREFS);
    expect(scoreboardPainted(rects)).toBe(false);
    const band = rects.filter((r) => r.y + r.h <= 22 && r.x < 240);
    expect(band.length).toBeGreaterThan(0);
    // Everything in the band stays clear of the speed/WPM readouts and the pause icon on the right.
    expect(Math.max(...band.map((r) => r.x + r.w))).toBeLessThanOrEqual(226);
  });
});

describe('Hud.draw in attract mode (a spectator)', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
  afterEach(() => vi.unstubAllGlobals());

  /** Frames with every HUD part up: lead-in banner, serve clock and situation banner, speed and WPM readouts, champion banner. */
  function busyFrames(viewer: PlayerId | 'spectator'): ReturnType<typeof worldFrame>[] {
    const intro = serveTurn();
    const preServe = serveTurn({ side: 'ad' });
    turnClock(preServe, 2600);
    const score: ScoreState = { ...createScore('bo3', 'advantage', 0), points: [2, 3] };
    const serve = serveTurn();
    turnInput(serve, 'toss', 2600);
    for (const [i, ch] of [...'ball'].entries()) turnInput(serve, ch, 2800 + i * 100);
    const o = serve.outcome;
    if (o?.kind !== 'strike') throw new Error('expected a strike');
    const ret = createTurn(returnData({ turnId: 8, incoming: o.strike.flight, chase: opt('ball'), isServeReturn: true, n: 0 }));
    startTurn(ret);
    const done: GameEvent = { turn: 7, τ: 0, type: 'wordDone', player: 0, prompt: 40, wpm: 61.6 };
    return [
      worldFrame(view(matchState(intro), 100, viewer)),
      worldFrame(view(matchState(preServe, null, { score }), 2600, viewer)),
      worldFrame(view(matchState(ret, serve), 100, viewer, [done])),
      worldFrame(view(matchState(null, ret, { status: 'over', winner: 1 }), 0, viewer), 500),
    ];
  }

  it('draws no scoreboard, serve clock, readouts, pause icon or banners, whatever the display prefs', () => {
    for (const prefs of [PREFS, { largeWords: true, reduceEffects: true, showWpm: true }]) {
      const hud = new Hud();
      for (const f of busyFrames('spectator')) {
        const { ctx, calls } = recordingContext();
        hud.update(f);
        hud.draw(ctx, f, prefs);
        expect(calls).toEqual([]);
      }
    }
  });

  it('while the same frames show the HUD to a player', () => {
    const hud = new Hud();
    for (const f of busyFrames(0)) {
      const { ctx, rects } = recordingContext();
      hud.update(f);
      hud.draw(ctx, f, PREFS);
      expect(rects.some((r) => r.x === PAUSE_ICON_RECT.x && r.y === PAUSE_ICON_RECT.y)).toBe(true);
    }
  });
});

describe('Hud.draw banners', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
  afterEach(() => vi.unstubAllGlobals());

  it('grows the point call\'s banner downward as the GAME line joins, keeping the call line in place', () => {
    const { pointMs, gameExtraMs } = TUNING.leadIn;
    const t = serveTurn({ leadIn: { kind: 'point', ms: pointMs + gameExtraMs, text: ['OUT', 'GAME KAI'] } });
    const panel = (τ: number): { y: number; h: number } | undefined => {
      const { ctx, rects } = recordingContext();
      new Hud().draw(ctx, worldFrame(view(matchState(t), τ)), PREFS);
      return rects.find((r) => r.x === 0 && r.w === 480 && r.h > 20 && r.y > 21);
    };
    const before = panel(pointMs - 300);
    const after = panel(pointMs + 300);
    expect(before).toBeDefined();
    expect(after).toEqual({ ...before, h: before!.h + 18 });
  });
});

describe('Hud readouts', () => {
  it('keeps the WPM of the viewer\'s last completed word and shows it only when enabled', () => {
    const t = serveTurn();
    const hud = new Hud();
    const done = (player: PlayerId, wpm: number): GameEvent => ({ turn: 7, τ: 0, type: 'wordDone', player, prompt: 40, wpm });
    hud.update(worldFrame(view(matchState(t), 100, 0, [done(0, 61.6)])));
    expect(hud.readouts(worldFrame(view(matchState(t), 100)), PREFS).wpm).toBe('62 WPM');
    hud.update(worldFrame(view(matchState(t), 200, 0, [done(1, 90)])));
    expect(hud.readouts(worldFrame(view(matchState(t), 200)), PREFS).wpm).toBe('62 WPM');
    expect(hud.readouts(worldFrame(view(matchState(t), 200)), { ...PREFS, showWpm: false }).wpm).toBeNull();
  });
});
