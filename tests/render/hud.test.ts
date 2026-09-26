import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import { createScore } from '../../src/core/scoring';
import { createTurn, startTurn, turnClock, turnInput } from '../../src/core/turn';
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
  scoreRows,
  serveClockSeconds,
  speedReadout,
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

describe('banners', () => {
  it('shows the lead-in text lines during the lead-in, sliding in and fading out', () => {
    const t = serveTurn({ leadIn: { kind: 'point', ms: 2000, text: ['OUT', 'GAME KAI'] } });
    const at = (τ: number): ReturnType<typeof bannerFor> => bannerFor(worldFrame(view(matchState(t), τ)));
    expect(at(0)).toMatchObject({ lines: ['OUT', 'GAME KAI'], ageMs: 0, leftMs: 2000 });
    expect(at(1500)).toMatchObject({ lines: ['OUT', 'GAME KAI'], ageMs: 1500, leftMs: 500 });
    turnClock(t, 2100);
    expect(at(2100)).toBeNull();
  });

  it('announces the situation when PRE_SERVE begins', () => {
    const score: ScoreState = { ...createScore('bo3', 'advantage', 0), points: [2, 3] };
    const t = serveTurn({ side: 'ad' });
    turnClock(t, 2600);
    const pub = matchState(t, null, { score });
    expect(bannerFor(worldFrame(view(pub, 2600)))).toMatchObject({ lines: ['BREAK POINT'], small: true });
    turnClock(t, 4500);
    expect(bannerFor(worldFrame(view(pub, 4500)))).toBeNull();
  });

  it('crowns the match winner once the match is over', () => {
    const last = createTurn(returnData({ incoming: flight() }));
    startTurn(last);
    turnClock(last, RALLY_IN.T + RALLY_IN.grace);
    const pub = matchState(null, last, { status: 'over', winner: 1 });
    const b = bannerFor(worldFrame(view(pub, 0), 500));
    expect(b?.lines).toEqual(['GAME, SET AND MATCH', 'KAI']);
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
