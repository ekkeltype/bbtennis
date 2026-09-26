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
import { BELT_COLOR, RAMPS } from '../../src/render/palette';
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

/** A 2D context stand-in that records every filled rectangle with its fill style. */
function recordingContext(): { ctx: CanvasRenderingContext2D; rects: { x: number; y: number; w: number; h: number; style: string }[] } {
  const rects: { x: number; y: number; w: number; h: number; style: string }[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(state.fillStyle) });
    },
  };
  const ctx = new Proxy(state, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
    set: (t, key: string, value) => {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
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
