import { describe, expect, it } from 'vitest';
import { buildFlight } from '../../../src/arcade/core/flight';
import { step } from '../../../src/arcade/core/match';
import { contactAt } from '../../../src/arcade/core/reach';
import { DT } from '../../../src/arcade/core/tuning';
import { NO_INPUT } from '../../../src/arcade/core/types';
import type { ArcadeEvent, ArcadeState, HitEvent, PlayerId, Vec2 } from '../../../src/arcade/core/types';
import { poseAt } from '../../../src/arcade/render/animator';
import { currentServer } from '../../../src/core/scoring';
import { other } from '../../../src/core/types';
import { forPlayer, matchInSetup, ofType, press, runTicks, runUntil, serveAce } from '../matchHelpers';

/** Its coin toss goes to player 0. */
const SEED = 1;

/** A rally: player 0 has just hit a straight deep topspin (x = 0 all the way) toward player 1. */
function rally(): ArcadeState {
  const { s } = matchInSetup(SEED);
  const hit: HitEvent = {
    tick: s.tick, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1,
    contact: { x: 0, y: -11, z: 1 }, target: { x: 0, y: 6 }, T: 1,
  };
  s.flight = buildFlight(hit);
  s.phase = { kind: 'rally' };
  s.toss = null;
  s.serveClockFrom = null;
  s.point.hits = 2;
  s.point.serveUnbounced = false;
  return s;
}

/** Player 1 standing still at `pos`, committed to topspin now. */
function committedAt(s: ArcadeState, pos: Vec2): void {
  s.p[1].pos = { ...pos };
  s.p[1].vel = { x: 0, y: 0 };
  s.p[1].commit = { shot: 'topspin', tick: s.tick };
}

/** The first tick on which player 1, standing at its position, meets the live flight. */
function contactTick(s: ArcadeState): number {
  const f = s.flight!;
  for (let n = s.tick + 1; (n - f.hit.tick) * DT < f.tEnd; n++) if (contactAt(1, s.p[1].pos, f, n, false)) return n;
  throw new Error('no contact');
}

/** Steps (nobody touching a key) until tick `n`, recording player 1's pose for viewer 0 at each tick's time. */
function posesUntil(s: ArcadeState, n: number): Map<number, ReturnType<typeof poseAt>> {
  const out = new Map<number, ReturnType<typeof poseAt>>();
  while (s.tick < n) {
    out.set(s.tick, poseAt(s, 1, s.tick * DT, 0));
    step(s, [NO_INPUT, NO_INPUT]);
  }
  return out;
}

describe('poseAt locomotion', () => {
  it('stands idle when still or slower than 0.2 m/s', () => {
    const s = rally();
    s.p[1].vel = { x: 0, y: 0 };
    expect(poseAt(s, 1, s.tick * DT, 0).anim).toBe('idle');
    s.p[1].vel = { x: 0.15, y: 0.1 };
    expect(poseAt(s, 1, s.tick * DT, 0).anim).toBe('idle');
  });

  it('runs right on screen for +x seen from end 0, and left for the same motion seen from end 1', () => {
    const s = rally();
    s.p[1].vel = { x: 5, y: 1 };
    s.p[0].vel = { x: 5, y: -1 };
    expect(poseAt(s, 1, s.tick * DT, 0).anim).toBe('runRight');
    expect(poseAt(s, 0, s.tick * DT, 0).anim).toBe('runRight');
    expect(poseAt(s, 1, s.tick * DT, 'spectator').anim).toBe('runRight');
    expect(poseAt(s, 1, s.tick * DT, 1).anim).toBe('runLeft');
    expect(poseAt(s, 0, s.tick * DT, 1).anim).toBe('runLeft');
  });

  it('runs toward or away from the net along y, for either end', () => {
    const s = rally();
    s.p[1].vel = { x: 0, y: -5 };
    s.p[0].vel = { x: 1, y: 5 };
    expect(poseAt(s, 1, s.tick * DT, 0).anim).toBe('runToward');
    expect(poseAt(s, 0, s.tick * DT, 0).anim).toBe('runToward');
    s.p[1].vel = { x: 0, y: 5 };
    expect(poseAt(s, 1, s.tick * DT, 1).anim).toBe('runAway');
  });

  it('puts the feet at pos + vel·(t − tick·DT), the near view at the viewer\'s end', () => {
    const s = rally();
    s.p[1].pos = { x: 1, y: 8 };
    s.p[1].vel = { x: 5, y: -2 };
    const p = poseAt(s, 1, s.tick * DT + 0.01, 0);
    expect(p.feet.x).toBeCloseTo(1.05, 9);
    expect(p.feet.y).toBeCloseTo(7.98, 9);
    expect(p.view).toBe('far');
    expect(poseAt(s, 0, s.tick * DT, 0).view).toBe('near');
    expect(poseAt(s, 1, s.tick * DT, 1).view).toBe('near');
    expect(poseAt(s, 0, s.tick * DT, 'spectator').view).toBe('near');
  });

  it('is pure: the same state and time give the same pose', () => {
    const s = rally();
    s.p[1].vel = { x: 5, y: 0 };
    const before = JSON.stringify(s);
    const a = poseAt(s, 1, s.tick * DT + 0.2, 0);
    expect(poseAt(s, 1, s.tick * DT + 0.2, 0)).toEqual(a);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('poseAt swings', () => {
  it('starts a committed forehand 180 ms out so that frame 2 lands on the contact tick', () => {
    const s = rally();
    committedAt(s, { x: 0.5, y: 10 });
    const n = contactTick(s);
    const c = contactAt(1, s.p[1].pos, s.flight!, n, false)!;
    expect(c.forehand).toBe(true);
    expect(c.stretch || c.smash).toBe(false);
    const before = posesUntil(s, n);
    expect(before.get(n - 11)!.anim).toBe('idle');
    expect(before.get(n - 10)).toMatchObject({ anim: 'forehand', frame: 0 });
    expect(before.get(n - 6)).toMatchObject({ anim: 'forehand', frame: 0 });
    expect(before.get(n - 5)).toMatchObject({ anim: 'forehand', frame: 1 });
    expect(before.get(n - 1)).toMatchObject({ anim: 'forehand', frame: 1 });
    // The sim hits on the predicted tick: the follow-through starts on the contact frame.
    expect(s.p[1].lastSwing).toEqual({ tick: n, stroke: 'forehand', stretch: false });
    expect(poseAt(s, 1, n * DT, 0)).toMatchObject({ anim: 'forehand', frame: 2, flip: false });
    expect(poseAt(s, 1, n * DT + 0.1, 0)).toMatchObject({ anim: 'forehand', frame: 3 });
    expect(poseAt(s, 1, n * DT + 0.46, 0).anim).toBe('idle');
  });

  it('plays a backhand when the ball passes on the backhand side', () => {
    const s = rally();
    committedAt(s, { x: -0.5, y: 10 });
    const n = contactTick(s);
    expect(posesUntil(s, n).get(n - 1)).toMatchObject({ anim: 'backhand', frame: 1 });
    expect(poseAt(s, 1, n * DT, 0)).toMatchObject({ anim: 'backhand', frame: 2 });
  });

  it('plays stretch for a forehand-side stretch, the backhand frames (never mirrored) for a backhand-side one', () => {
    for (const x of [1.2, -1.2]) {
      const s = rally();
      committedAt(s, { x, y: 10 });
      const n = contactTick(s);
      expect(contactAt(1, s.p[1].pos, s.flight!, n, false)!.stretch).toBe(true);
      const forehand = x > 0;
      const before = posesUntil(s, n).get(n - 1);
      expect(before).toMatchObject(forehand ? { anim: 'stretch', frame: 0, flip: false } : { anim: 'backhand', frame: 1, flip: false });
      expect(s.p[1].lastSwing).toMatchObject({ tick: n, stroke: forehand ? 'forehand' : 'backhand', stretch: true });
      const at = poseAt(s, 1, n * DT, 0);
      expect(at).toMatchObject(forehand ? { anim: 'stretch', frame: 1, flip: false } : { anim: 'backhand', frame: 2, flip: false });
    }
  });

  it('plays a smash on serve frames 2–3', () => {
    const s = rally();
    s.p[1].lastSwing = { tick: s.tick, stroke: 'smash', stretch: false };
    expect(poseAt(s, 1, s.tick * DT, 0)).toMatchObject({ anim: 'serve', frame: 2 });
    expect(poseAt(s, 1, s.tick * DT + 0.1, 0)).toMatchObject({ anim: 'serve', frame: 3 });
  });

  it('plays the serve: frame 0 at set-up, 0 → 1 as the toss rises, 2–3 on the hit', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    expect(poseAt(s, server, s.tick * DT, 0)).toMatchObject({ anim: 'serve', frame: 0 });
    expect(poseAt(s, other(server), s.tick * DT, 0).anim).toBe('idle');
    step(s, forPlayer(server, press('topspin')));
    expect(s.phase.kind).toBe('toss');
    expect(poseAt(s, server, s.tick * DT, 0)).toMatchObject({ anim: 'serve', frame: 0 });
    runTicks(s, 30);
    expect(s.phase.kind).toBe('toss');
    expect(poseAt(s, server, s.tick * DT, 0)).toMatchObject({ anim: 'serve', frame: 1 });
    const hit = ofType(step(s, forPlayer(server, press('slice'))), 'hit');
    expect(hit).toHaveLength(1);
    expect(poseAt(s, server, s.tick * DT, 0)).toMatchObject({ anim: 'serve', frame: 2 });
    expect(poseAt(s, server, s.tick * DT + 0.1, 0)).toMatchObject({ anim: 'serve', frame: 3 });
  });
});

describe('poseAt after a point', () => {
  it('has the winner celebrate and the loser hang their head after a game, not after a plain point', () => {
    const { s } = matchInSetup(SEED);
    let events: ArcadeEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events = serveAce(s);
      if (ofType(events, 'game').length > 0) break;
      expect(s.phase.kind).toBe('dead');
      for (const p of [0, 1] as const) expect(['celebrate', 'dejected']).not.toContain(poseAt(s, p, s.tick * DT, 0).anim);
      runUntil(s, (st) => st.phase.kind === 'setup');
    }
    const game = ofType(events, 'game');
    expect(game).toHaveLength(1);
    const winner: PlayerId = game[0]!.winner;
    expect(poseAt(s, winner, s.tick * DT, 0).anim).toBe('celebrate');
    expect(poseAt(s, other(winner), s.tick * DT, 0).anim).toBe('dejected');
    runTicks(s, 120);
    expect(s.phase.kind).toBe('dead');
    expect(poseAt(s, winner, s.tick * DT, 1).anim).toBe('celebrate');
  });
});
