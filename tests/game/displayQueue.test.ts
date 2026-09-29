import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/core/engine';
import { seedRng, uniform } from '../../src/core/rng';
import type { GameEvent, TurnState } from '../../src/core/types';
import { DisplayQueue, ONLINE_PLAYBACK } from '../../src/game/displayQueue';
import { FreshEvents, STALE_EVENT_MS, STALL_MS, StallWatch } from '../../src/game/onlineLink';
import { PLAYERS, TIEBREAK } from './sessionHelpers';

const FRAME = 16;

/** A real (unstarted) serve turn renumbered to `id`; with `endτ` it has ended there. */
function turnOf(id: number, endτ: number | null = null): TurnState {
  const t = JSON.parse(JSON.stringify(new Engine({ config: TIEBREAK, players: PLAYERS, seed: 1 }).state.turn)) as TurnState;
  t.data.turnId = id;
  t.started = true;
  if (endτ !== null) ended(t, endτ);
  return t;
}

function ended(t: TurnState, endτ: number): TurnState {
  t.ended = true;
  t.phase = 'ended';
  t.outcome = { kind: 'fault', endτ, reason: 'ballDropped' };
  return t;
}

function ev(turn: number, τ: number): GameEvent {
  return { turn, τ, type: 'keyOk', player: 0, prompt: 1 };
}

const id = (t: TurnState | undefined | null): number | null => t?.data.turnId ?? null;

describe('DisplayQueue: the front', () => {
  it('uses the online playback tuning of spec §5.2 (60 ms behind the owner, at most 10 % fast)', () => {
    expect(ONLINE_PLAYBACK).toEqual({ margin: 60, maxRate: 1.1, relaxMs: 500 });
  });

  it('shows nothing until a turn is pushed; the first one becomes the front at the next advance', () => {
    const q = new DisplayQueue(1000);
    expect(q.advance(1016)).toEqual([]);
    expect(q.front).toBeNull();
    expect(q.τ).toBe(0);
    const e = q.push(turnOf(1), true);
    expect(q.front).toBeNull();
    expect(q.advance(1040)).toEqual([e]);
    expect(q.front).toBe(e);
    expect(e.startedAt).toBe(1040);
  });

  it('a local front shows the live τ: now − the time it became the front', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    q.advance(500);
    q.advance(516);
    expect(q.τ).toBe(16);
    q.advance(1733);
    expect(q.τ).toBe(1233);
  });

  it('a remote front shows τ_play: it starts at 0 and never passes the owner\'s confirmed τ', () => {
    const q = new DisplayQueue(0);
    const e = q.push(turnOf(1), false);
    expect(e.clock).not.toBeNull();
    q.advance(0);
    for (let t = FRAME; t <= 2000; t += FRAME) q.advance(t);
    expect(q.τ).toBe(0);
    q.confirm(1, 300);
    for (let t = 2000 + FRAME; t <= 4000; t += FRAME) {
      q.advance(t);
      expect(q.τ).toBeLessThanOrEqual(300);
    }
    expect(q.τ).toBe(300);
  });

  it('a remote front never exceeds the confirmed τ and never decreases, whatever the confirmations and frame times', () => {
    const rng = seedRng(21);
    const q = new DisplayQueue(0);
    q.push(turnOf(1), false);
    let now = 0;
    let confirmed = 0;
    let prev = 0;
    q.advance(now);
    for (let i = 0; i < 4000; i++) {
      if (uniform(rng) < 0.3) {
        const τc = confirmed + (uniform(rng) - 0.2) * 300;
        q.confirm(1, τc);
        confirmed = Math.max(confirmed, τc);
      }
      now += uniform(rng) * 120;
      q.advance(now);
      expect(q.τ).toBeLessThanOrEqual(confirmed);
      expect(q.τ).toBeGreaterThanOrEqual(prev);
      prev = q.τ;
    }
    expect(prev).toBeGreaterThan(0);
  });
});

describe('DisplayQueue: pop, hold and carry', () => {
  it('pops an ended front once its displayed τ reaches endτ: the next turn becomes the front, the old one is carried as previous', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1), true);
    q.advance(100);
    const b = q.push(turnOf(2), false);
    q.update(ended(turnOf(1), 700));
    expect(q.advance(700)).toEqual([]);
    expect(q.front).toBe(a);
    expect(q.τ).toBe(600);
    expect(q.advance(820)).toEqual([b]);
    expect(q.front).toBe(b);
    expect(q.previous).toBe(a);
    expect(id(q.previous?.turn)).toBe(1);
    // The next entry's clock begins at 0 when it becomes the front.
    expect(q.τ).toBe(0);
    expect(b.startedAt).toBe(820);
  });

  it('holds an ended front at endτ until the next entry exists, never extrapolating past it', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1), false);
    q.advance(0);
    q.confirm(1, 5000);
    q.update(ended(turnOf(1), 900));
    for (let t = FRAME; t <= 4000; t += FRAME) q.advance(t);
    expect(q.front).toBe(a);
    expect(q.τ).toBe(900);
    const b = q.push(turnOf(2), true);
    expect(q.advance(4016)).toEqual([b]);
    expect(q.previous).toBe(a);
    expect(q.front).toBe(b);
    expect(b.startedAt).toBe(4016);
  });

  it('a local front that ended holds at endτ too (the owner\'s clock goes on, the display does not)', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1), true);
    q.advance(0);
    a.turn = ended(a.turn, 450);
    q.update(a.turn);
    q.advance(2000);
    expect(q.τ).toBe(450);
    expect(q.front).toBe(a);
  });

  it('an ended remote turn plays to its endτ even when the owner\'s last confirmation was below it', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), false);
    q.push(turnOf(2), true);
    q.advance(0);
    q.confirm(1, 400);
    q.update(ended(turnOf(1), 520));
    let t = 0;
    while (q.front?.turn.data.turnId === 1 && t < 5000) q.advance((t += FRAME));
    expect(id(q.front?.turn)).toBe(2);
    expect(q.previous?.τ).toBe(520);
  });

  it('a queued remote turn keeps its early confirmations but still starts at 0, catching up at most 10 % fast', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    const b = q.push(turnOf(2), false);
    q.advance(0);
    q.confirm(2, 800);
    q.update(ended(q.front!.turn, 100));
    q.advance(100);
    expect(q.front).toBe(b);
    expect(q.τ).toBe(0);
    q.advance(200);
    expect(q.τ).toBeGreaterThan(0);
    expect(q.τ).toBeLessThanOrEqual(110 + 1e-9);
  });

  it('a turn that became the front starts at τ 0, so it is never shown to its end in the advance that began it', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1, 0.5), true);
    const b = q.push(turnOf(2), true);
    expect(q.advance(10)).toEqual([a]);
    expect(q.τ).toBe(0);
    expect(q.advance(11)).toEqual([b]);
    expect(q.previous).toBe(a);
    expect(q.front).toBe(b);
  });

  it('passes a turn that ended at τ 0 straight through the front, beginning the next one in the same advance', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1, 0), true);
    const b = q.push(turnOf(2), true);
    expect(q.advance(10)).toEqual([a, b]);
    expect(q.previous).toBe(a);
    expect(q.front).toBe(b);
  });

  it('after end(), the last turn leaves the front once shown to its end: no front, the last turn is previous', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1), false);
    q.advance(0);
    q.confirm(1, 300);
    q.update(ended(turnOf(1), 300));
    q.end();
    let t = 0;
    while (q.front !== null && t < 5000) q.advance((t += FRAME));
    expect(q.front).toBeNull();
    expect(q.previous).toBe(a);
    expect(q.finishedAt).toBe(t);
    expect(q.τ).toBe(0);
  });

  it('finds entries by turn id (queued, front or previous) and ignores updates and confirmations for unknown ids', () => {
    const q = new DisplayQueue(0);
    const a = q.push(turnOf(1), true);
    const b = q.push(turnOf(2), false);
    expect(q.get(1)).toBe(a);
    expect(q.get(2)).toBe(b);
    expect(q.get(3)).toBeNull();
    q.update(ended(turnOf(3), 10));
    q.confirm(3, 10);
    q.confirm(1, 10);
    expect(a.clock).toBeNull();
    const fresh = turnOf(2);
    q.update(fresh);
    expect(b.turn).toBe(fresh);
    expect(b.endτ).toBeNull();
  });
});

describe('DisplayQueue: events', () => {
  it('holds events of turns not yet displayed and releases them, in order, as playback passes their τ', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), false);
    q.advance(0);
    q.hold([ev(1, 0), ev(1, 100), ev(1, 250), ev(2, 0)]);
    expect(q.release()).toEqual([ev(1, 0)]);
    q.confirm(1, 1000);
    let t = 0;
    while (q.τ < 100) q.advance((t += FRAME));
    expect(q.release()).toEqual([ev(1, 100)]);
    expect(q.release()).toEqual([]);
    q.update(ended(turnOf(1), 300));
    q.push(turnOf(2), true);
    while (id(q.front?.turn) !== 2) q.advance((t += FRAME));
    expect(q.release()).toEqual([ev(1, 250), ev(2, 0)]);
  });

  it('holds everything while nothing is displayed, and releases the last turn\'s events once the match is shown to its end', () => {
    const q = new DisplayQueue(0);
    q.hold([ev(1, 0)]);
    expect(q.release()).toEqual([]);
    q.push(turnOf(1, 200), true);
    q.end();
    q.hold([ev(1, 200)]);
    q.advance(0);
    expect(q.release()).toEqual([ev(1, 0)]);
    q.advance(200);
    expect(q.front).toBeNull();
    expect(q.release()).toEqual([ev(1, 200)]);
  });

  it('dropStale drops the reached events more than maxAge of display time behind it: the front\'s by front τ − τ, the previous turn\'s by its end − τ + front τ, older turns\' always; events not reached stay held', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1, 1000), true);
    q.push(turnOf(2, 2000), true);
    q.push(turnOf(3), true);
    q.advance(0);
    q.hold([ev(1, 990), ev(2, 100), ev(2, 1949), ev(2, 1950), ev(3, 0), ev(3, 250), ev(3, 5000)]);
    q.advance(1000);
    q.advance(3000);
    q.advance(3250);
    expect(id(q.front?.turn)).toBe(3);
    expect(q.τ).toBe(250);
    q.dropStale(300);
    // Ages: turn 1 is older than the previous turn; 2150, 301 and exactly 300 for turn 2; 250 and 0 for turn 3.
    expect(q.release()).toEqual([ev(2, 1950), ev(3, 0), ev(3, 250)]);
    q.advance(8250);
    expect(q.release()).toEqual([ev(3, 5000)]);
  });

  it('dropStale after the last turn has been shown ages its events by the time since then', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1, 1000), true);
    q.end();
    q.advance(0);
    q.hold([ev(1, 700), ev(1, 900)]);
    q.advance(1000);
    q.advance(1150);
    expect(q.front).toBeNull();
    q.dropStale(300);
    expect(q.release()).toEqual([ev(1, 900)]);
  });

  it('dropStale keeps every event that is not yet reached, and nothing is dropped twice', () => {
    const q = new DisplayQueue(0);
    q.hold([ev(1, 0)]);
    q.dropStale(0);
    q.push(turnOf(1), true);
    q.advance(0);
    q.advance(100);
    q.dropStale(300);
    expect(q.release()).toEqual([ev(1, 0)]);
  });
});

describe('FreshEvents: the events a frame shows (spec §5.2)', () => {
  it('uses the 300 ms of spec §5.2', () => {
    expect(STALE_EVENT_MS).toBe(300);
  });

  it('shows every reached event, however old, while frames come at most 300 ms apart', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    q.advance(0);
    const fresh = new FreshEvents();
    expect(fresh.release(q, 0)).toEqual([]);
    q.hold([ev(1, 0)]);
    q.advance(300);
    fresh.tick(q, 300);
    expect(fresh.release(q, 300)).toEqual([ev(1, 0)]);
    q.hold([ev(1, 10)]);
    q.advance(600);
    fresh.tick(q, 600);
    expect(fresh.release(q, 600)).toEqual([ev(1, 10)]);
  });

  it('once frames stop for more than 300 ms, each tick drops the events the display passed more than 300 ms ago, so none pile up', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    q.advance(0);
    const fresh = new FreshEvents();
    fresh.release(q, 0);
    q.hold([ev(1, 100), ev(1, 900)]);
    for (let t = 50; t <= 1150; t += 50) {
      q.advance(t);
      fresh.tick(q, t);
    }
    // At 1150 the display is at τ 1150: the event at 100 went on a tick, the one at 900 (250 ms old) waits.
    expect(q.release()).toEqual([ev(1, 900)]);
  });

  it('the first frame back from a gap of more than 300 ms shows only the events of the last 300 ms of display; later frames show all again', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    q.advance(0);
    const fresh = new FreshEvents();
    fresh.release(q, 0);
    q.hold([ev(1, 100), ev(1, 1099), ev(1, 1100), ev(1, 1500)]);
    q.advance(1400);
    expect(fresh.release(q, 1400)).toEqual([ev(1, 1100)]);
    q.advance(1700);
    expect(fresh.release(q, 1700)).toEqual([ev(1, 1500)]);
  });

  it("shows early-chase feedback in the next frame, ahead of held events the display has not reached, in turn and τ order (early-typing spec §6.4)", () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    q.advance(0);
    const fresh = new FreshEvents();
    fresh.release(q, 0);
    q.hold([ev(1, 50), ev(1, 400)]);
    q.advance(100);
    fresh.live([ev(1, 90)], 100);
    expect(fresh.release(q, 100)).toEqual([ev(1, 50), ev(1, 90)]);
    q.advance(116);
    expect(fresh.release(q, 116)).toEqual([]);
  });

  it('once frames stop for more than 300 ms, drops early-chase feedback more than 300 ms old, on a tick or the first frame back', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), true);
    q.advance(0);
    const fresh = new FreshEvents();
    fresh.release(q, 0);
    fresh.live([ev(1, 10)], 10);
    fresh.live([ev(1, 700)], 700);
    q.advance(750);
    fresh.tick(q, 750);
    fresh.live([ev(1, 760)], 760);
    q.advance(1050);
    expect(fresh.release(q, 1050)).toEqual([ev(1, 760)]);
  });
});

describe('StallWatch: stalled confirmations (spec §5.3)', () => {
  /** Frames a queue whose front is a remote turn every FRAME ms from `from` to `to`, and the first frame the watch called stalled (null: none). */
  function firstStall(q: DisplayQueue, w: StallWatch, rtt: number | null, from: number, to: number): number | null {
    for (let t = from; t <= to; t += FRAME) {
      q.advance(t);
      if (w.update(q.front, rtt, t)) return t;
    }
    return null;
  }

  it('uses the 1 s of spec §5.3', () => {
    expect(STALL_MS).toBe(1000);
  });

  it('a remote front whose playback holds at the confirmed τ is stalled 1 s after the latest rise of that τ, and not once it rises again', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), false);
    q.advance(0);
    const w = new StallWatch();
    q.confirm(1, 500);
    expect(firstStall(q, w, 200, 0, 3000)).toBe(1008);
    expect(q.τ).toBe(500);
    q.confirm(1, 800);
    // Noticed at the next frame (1024); the playback catches up and holds at 800 until 1 s after that.
    expect(firstStall(q, w, 200, 1024, 5000)).toBe(2032);
    expect(q.τ).toBe(800);
  });

  it('a turn with no confirmation yet is stalled only one round trip and 1 s after it became the front (the hand-off freeze is normal); 1 s is assumed before a round trip is known', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1), false);
    q.advance(100);
    expect(firstStall(q, new StallWatch(), 800, 100, 5000)).toBe(1908);
    const r = new DisplayQueue(0);
    r.push(turnOf(1), false);
    r.advance(100);
    expect(firstStall(r, new StallWatch(), null, 100, 5000)).toBe(2100);
  });

  it('never stalls a local front, a remote front that has ended, or playback still catching up with the confirmed τ', () => {
    const local = new DisplayQueue(0);
    local.push(turnOf(1), true);
    expect(firstStall(local, new StallWatch(), 100, 0, 5000)).toBeNull();
    const ended = new DisplayQueue(0);
    ended.push(turnOf(1, 900), false);
    expect(firstStall(ended, new StallWatch(), 100, 0, 5000)).toBeNull();
    const behind = new DisplayQueue(0);
    behind.push(turnOf(1), false);
    behind.advance(0);
    behind.confirm(1, 20_000);
    expect(firstStall(behind, new StallWatch(), 100, 0, 5000)).toBeNull();
    expect(behind.τ).toBeGreaterThan(4000);
  });

  it('a new front starts the watch afresh', () => {
    const q = new DisplayQueue(0);
    q.push(turnOf(1, 300), false);
    const b = q.push(turnOf(2), false);
    q.advance(0);
    const w = new StallWatch();
    let t = 0;
    while (q.front !== b) {
      t += FRAME;
      q.advance(t);
      expect(w.update(q.front, 0, t)).toBe(false);
    }
    expect(firstStall(q, w, 0, t, t + 2000)).toBe(t + 1008);
  });
});
