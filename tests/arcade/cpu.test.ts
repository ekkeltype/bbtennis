import { describe, expect, it } from 'vitest';
import { ArcadeCpu, arcadeCpuHome, arcadeCpuProfile } from '../../src/arcade/core/cpu';
import type { ArcadeCpuProfile } from '../../src/arcade/core/cpu';
import { buildFlight, clampTForApex, inCourtFor } from '../../src/arcade/core/flight';
import { createMatch, step } from '../../src/arcade/core/match';
import { tossZ } from '../../src/arcade/core/shot';
import { ARCADE, ARCADE_CPU_MILESTONES, TICK_HZ } from '../../src/arcade/core/tuning';
import { NO_INPUT } from '../../src/arcade/core/types';
import type { ArcadeEvent, ArcadeState, Grade, HitEvent, PlayerId, PlayerInfo, PlayerInput, ShotType } from '../../src/arcade/core/types';
import { seedRng, uniform } from '../../src/core/rng';
import { currentServer } from '../../src/core/scoring';
import { CONFIG, IDLE, PLAYERS, matchInSetup, ofType, runUntil } from './matchHelpers';

const LOOK = PLAYERS[0].look;
const CPU_PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'CPU A', look: LOOK, kind: 'cpu', cpuLevel: 9 },
  { name: 'CPU B', look: LOOK, kind: 'cpu', cpuLevel: 9 },
];

/** A milestone row without its level, as a profile. */
function row(i: number): ArcadeCpuProfile {
  const r = ARCADE_CPU_MILESTONES[i]!;
  return { reaction: r.reaction, readError: r.readError, speed: r.speed, pressSigma: r.pressSigma, aggression: r.aggression };
}

/** Why `v` is not exactly a valid PlayerInput (five fields, axes −1, 0 or 1 without −0, boolean keys), or null. */
function inputProblem(v: PlayerInput): string | null {
  if (Object.keys(v).sort().join() !== 'lob,mx,my,slice,topspin') return `fields ${Object.keys(v).join()}`;
  for (const a of [v.mx, v.my]) if (!(a === 1 || a === -1 || Object.is(a, 0))) return `axis ${String(a)}`;
  for (const k of [v.topspin, v.slice, v.lob]) if (typeof k !== 'boolean') return `key ${String(k)}`;
  return null;
}

/** First tick count after the toss at which the toss is below the drop height. */
function dropTicks(): number {
  let n = 0;
  while (tossZ(n, CONFIG.pace) >= ARCADE.serve.dropZ) n++;
  return n;
}

/**
 * The fixed launcher: a state in 'rally' with a neutral topspin from player 0, hit on the current
 * tick from (0, −11.5, 1.0) toward (jitterX, 9.4) with the physics' T, the CPU (player 1) at rest
 * on its home spot behind the centre of its baseline (direct set-up).
 */
function launch(seed: number, jitterX: number): ArcadeState {
  const { s } = matchInSetup(seed);
  const contact = { x: 0, y: -11.5, z: 1.0 };
  const target = { x: jitterX, y: 9.4 };
  const dx = target.x - contact.x;
  const dy = target.y - contact.y;
  const ph = ARCADE.shots.topspin;
  const T = clampTForApex(contact.z, ph.k, Math.sqrt(dx * dx + dy * dy) / (ph.speed * ARCADE.pace[s.config.pace]));
  const hit: HitEvent = { tick: s.tick, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1, contact, target, T };
  s.flight = buildFlight(hit);
  s.phase = { kind: 'rally' };
  s.toss = null;
  s.serveClockFrom = null;
  s.point.hits = 2;
  s.point.serveUnbounced = false;
  s.p[0].pos = { x: contact.x, y: contact.y };
  s.p[0].vel = { x: 0, y: 0 };
  s.p[1].pos = arcadeCpuHome(1);
  s.p[1].vel = { x: 0, y: 0 };
  s.p[1].commit = null;
  s.p[1].held = { topspin: false, slice: false, lob: false };
  return s;
}

/** Lateral jitter of each of the 200 launcher balls (±2 m), the same for every level. */
const JITTER: number[] = (() => {
  const r = seedRng(8080);
  return Array.from({ length: 200 }, () => -2 + 4 * uniform(r));
})();

interface ReturnStats { landed: number; crossed: number; hits: number; perfect: number }

/** Plays the 200 launcher balls against a CPU of `level` (player 0 idle) until its hit or the point. */
function returnStats(level: number): ReturnStats {
  const out: ReturnStats = { landed: 0, crossed: 0, hits: 0, perfect: 0 };
  JITTER.forEach((jx, i) => {
    const seed = 500 + i;
    const s = launch(seed, jx);
    const cpu = new ArcadeCpu(1, level, seed);
    for (let n = 0; n < 600; n++) {
      const ev = step(s, [NO_INPUT, cpu.input(s)]);
      const hit = ofType(ev, 'hit').find((e) => e.hit.player === 1);
      if (hit !== undefined) {
        const f = s.flight!;
        out.hits += 1;
        if (hit.hit.grade === 'perfect') out.perfect += 1;
        if (!f.net) out.crossed += 1;
        const first = f.bounces[0];
        if (!f.net && first !== undefined && inCourtFor(first.at, 0)) out.landed += 1;
        return;
      }
      if (ofType(ev, 'point').length > 0) return;
    }
  });
  return out;
}

describe('arcadeCpuProfile', () => {
  it('milestone levels are their rows; level 1 lies between White and Yellow; out-of-range levels throw', () => {
    expect(arcadeCpuProfile(0)).toEqual(row(0));
    expect(arcadeCpuProfile(14)).toEqual(row(5));
    for (let i = 0; i < ARCADE_CPU_MILESTONES.length; i++) expect(arcadeCpuProfile(ARCADE_CPU_MILESTONES[i]!.level)).toEqual(row(i));
    const p1 = arcadeCpuProfile(1);
    const white = row(0);
    const yellow = row(1);
    for (const k of Object.keys(white) as (keyof ArcadeCpuProfile)[]) {
      expect(p1[k], k).toBeGreaterThan(Math.min(white[k], yellow[k]));
      expect(p1[k], k).toBeLessThan(Math.max(white[k], yellow[k]));
    }
    expect(p1.reaction).toBeCloseTo(white.reaction + (yellow.reaction - white.reaction) / 3, 12);
    expect(() => arcadeCpuProfile(15)).toThrow(RangeError);
    expect(() => arcadeCpuProfile(-1)).toThrow(RangeError);
    expect(() => arcadeCpuProfile(1.5)).toThrow(RangeError);
    expect(() => arcadeCpuProfile(Number.NaN)).toThrow(RangeError);
  });

  it('the constructor rejects an invalid level', () => {
    expect(() => new ArcadeCpu(0, 15, 1)).toThrow(RangeError);
  });
});

describe('returns from the fixed launcher (200 neutral topspin balls, lateral jitter ±2 m)', () => {
  const black = returnStats(12);
  const white = returnStats(0);

  it('Black belt (level 12) returns ≥ 90 % into the court', () => {
    expect(black.landed / 200).toBeGreaterThanOrEqual(0.9);
  });

  it('White belt returns ≥ 40 % into the court, and no more than Black belt', () => {
    expect(white.landed / 200).toBeGreaterThanOrEqual(0.4);
    expect(white.landed).toBeLessThanOrEqual(black.landed);
  });

  it('commits so that contact falls in the perfect window: Black belt mostly perfect (≥ 70 % of hits), White less often', () => {
    expect(black.perfect / black.hits).toBeGreaterThanOrEqual(0.7);
    expect(white.perfect / white.hits).toBeLessThan(black.perfect / black.hits);
  });

  it('measured rates (for the report)', () => {
    const pct = (n: number): string => `${((100 * n) / 200).toFixed(1)} %`;
    const line = (name: string, r: ReturnStats): string =>
      `${name}: landed in ${pct(r.landed)}, crossed the net ${pct(r.crossed)}, hit ${pct(r.hits)}, perfect ${pct(r.perfect)}`;
    console.log(`[cpu returns] ${line('L12', black)} | ${line('L0', white)}`);
    expect(black.hits).toBeGreaterThanOrEqual(black.landed);
  });
});

describe('reaction and recovery', () => {
  it('keeps its previous plan (standing still) for the reaction time after the opponent hit, then moves', () => {
    for (const level of [0, 14]) {
      const s = launch(77, 1.8);
      const cpu = new ArcadeCpu(1, level, 77);
      const react = Math.round(arcadeCpuProfile(level).reaction * TICK_HZ);
      const hitTick = s.flight!.hit.tick;
      let firstMove: number | null = null;
      for (let n = 0; n < 60 && firstMove === null; n++) {
        const inp = cpu.input(s);
        if (inp.mx !== 0 || inp.my !== 0) firstMove = s.tick + 1;
        step(s, [NO_INPUT, inp]);
      }
      expect(firstMove, `level ${level}`).not.toBeNull();
      expect(firstMove! - hitTick, `level ${level}`).toBeGreaterThanOrEqual(react);
      expect(firstMove! - hitTick, `level ${level}`).toBeLessThanOrEqual(react + 2);
    }
  });

  it('after its own hit it recovers behind the centre of its baseline, 0.6 m toward its shot side', () => {
    const s = launch(91, 0.5);
    const cpu = new ArcadeCpu(1, 12, 91);
    const ev = runUntil(s, (_st, e) => e.some((x) => x.type === 'hit' || x.type === 'point'), () => [NO_INPUT, cpu.input(s)], 400);
    const hit = ofType(ev, 'hit').find((e) => e.hit.player === 1);
    expect(hit).toBeDefined();
    const tx = hit!.hit.target.x;
    const home = { x: tx > 0 ? 0.6 : tx < 0 ? -0.6 : 0, y: arcadeCpuHome(1).y };
    for (let n = 0; n < 60; n++) step(s, [NO_INPUT, cpu.input(s)]);
    expect(s.phase.kind).toBe('rally');
    const p = s.p[1].pos;
    const dx = p.x - home.x;
    const dy = p.y - home.y;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(0.5);
  });
});

interface ServeRecord { setupTick: number; tossTick: number; hitTick: number; grade: Grade; type: ShotType; serveNo: 1 | 2; dropped: boolean }

/** One CPU serve per seed (the server is the CPU, the receiver idle); odd seeds play a second serve. */
function serves(level: number, count: number): ServeRecord[] {
  const out: ServeRecord[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 3000 + i;
    const s = createMatch(CONFIG, PLAYERS, seed);
    const serveNo: 1 | 2 = i % 2 === 0 ? 1 : 2;
    s.point.serveNo = serveNo;
    const setupEv = runUntil(s, (st) => st.phase.kind === 'setup', IDLE, 1000);
    const setupTick = ofType(setupEv, 'setup')[0]!.tick;
    const server: PlayerId = currentServer(s.score);
    const cpu = new ArcadeCpu(server, level, seed);
    const ev: ArcadeEvent[] = runUntil(
      s,
      (_st, e) => e.some((x) => x.type === 'hit' || x.type === 'tossDropped' || x.type === 'call'),
      (st) => (server === 0 ? [cpu.input(st), NO_INPUT] : [NO_INPUT, cpu.input(st)]),
      3000,
    );
    const toss = ofType(ev, 'toss')[0];
    const hit = ofType(ev, 'hit')[0];
    out.push({
      setupTick, tossTick: toss?.tick ?? -1, hitTick: hit?.tick ?? -1, grade: hit?.hit.grade ?? 'rushed', type: hit?.hit.type ?? 'topspin',
      serveNo, dropped: ofType(ev, 'tossDropped').length > 0 || hit === undefined,
    });
  }
  return out;
}

describe('serving', () => {
  const drop = dropTicks();
  const top = serves(14, 200);
  const low = serves(0, 100);

  it('always tosses 0.6–1.2 s after the set-up starts and hits before the toss drops', () => {
    for (const r of [...top, ...low]) {
      expect(r.dropped).toBe(false);
      expect(r.tossTick - r.setupTick).toBeGreaterThanOrEqual(Math.round(0.6 * TICK_HZ));
      expect(r.tossTick - r.setupTick).toBeLessThanOrEqual(Math.round(1.2 * TICK_HZ));
      expect(r.hitTick - r.tossTick).toBeGreaterThanOrEqual(2);
      expect(r.hitTick - r.tossTick).toBeLessThan(drop);
    }
  });

  it('a first serve is flat or slice, a second serve is a kick', () => {
    for (const r of [...top, ...low]) {
      if (r.serveNo === 1) expect(['serveFlat', 'serveSlice']).toContain(r.type);
      else expect(r.type).toBe('serveKick');
    }
    expect(top.some((r) => r.type === 'serveFlat')).toBe(true);
    expect(top.some((r) => r.type === 'serveSlice')).toBe(true);
  });

  it('level 14 serve grades are ≥ 50 % perfect', () => {
    const perfect = top.filter((r) => r.grade === 'perfect').length;
    const lowPerfect = low.filter((r) => r.grade === 'perfect').length;
    console.log(`[cpu serves] L14 perfect ${perfect}/200, clean ${top.filter((r) => r.grade === 'clean').length}, rushed ${top.filter((r) => r.grade === 'rushed').length} | L0 perfect ${lowPerfect}/100`);
    expect(perfect / top.length).toBeGreaterThanOrEqual(0.5);
  });
});

/** Steps a CPU-vs-CPU match for `ticks`, calling `each` with both inputs before each step; returns the events. */
function cpuVsCpu(seed: number, levels: [number, number], ticks: number, each: (s: ArcadeState, inp: [PlayerInput, PlayerInput]) => void = () => {}): ArcadeEvent[] {
  const s = createMatch(CONFIG, CPU_PLAYERS, seed);
  const cpus = [new ArcadeCpu(0, levels[0], seed), new ArcadeCpu(1, levels[1], seed)] as const;
  const events: ArcadeEvent[] = [];
  for (let n = 0; n < ticks; n++) {
    const inp: [PlayerInput, PlayerInput] = [cpus[0].input(s), cpus[1].input(s)];
    each(s, inp);
    events.push(...step(s, inp));
  }
  return events;
}

describe('determinism and fairness', () => {
  it('same seed and same states give the same inputs; its memory is plain JSON data', () => {
    const s = createMatch(CONFIG, CPU_PLAYERS, 7);
    const a0 = new ArcadeCpu(0, 9, 7);
    const a1 = new ArcadeCpu(1, 9, 7);
    const b1 = new ArcadeCpu(1, 9, 7);
    const seqA: PlayerInput[] = [];
    const seqB: PlayerInput[] = [];
    const events: ArcadeEvent[] = [];
    for (let n = 0; n < 6000; n++) {
      const i0 = a0.input(s);
      const i1 = a1.input(s);
      seqA.push(i1);
      seqB.push(b1.input(s));
      if (n % 500 === 0) expect(JSON.parse(JSON.stringify(a1.memory))).toEqual(a1.memory);
      events.push(...step(s, [i0, i1]));
    }
    expect(seqB).toEqual(seqA);
    const hits = ofType(events, 'hit');
    expect(hits.filter((e) => e.hit.player === 0 && e.hit.type.startsWith('serve') === false).length).toBeGreaterThan(3);
    expect(hits.filter((e) => e.hit.player === 1 && e.hit.type.startsWith('serve') === false).length).toBeGreaterThan(3);

    const replay: PlayerInput[] = [];
    cpuVsCpu(7, [9, 9], 6000, (_s, inp) => replay.push(inp[1]));
    expect(replay).toEqual(seqA);
  });

  it('inputs are always valid PlayerInputs, and a shot key is never down on two ticks in a row', () => {
    for (const [seed, levels] of [[11, [0, 14]], [12, [6, 9]], [13, [14, 3]]] as const) {
      const prev: [PlayerInput | null, PlayerInput | null] = [null, null];
      const problems: string[] = [];
      let presses = 0;
      cpuVsCpu(seed, [levels[0], levels[1]], 5000, (s, inp) => {
        for (const p of [0, 1] as const) {
          const v = inp[p];
          const bad = inputProblem(v);
          if (bad !== null) problems.push(`tick ${s.tick + 1} p${p}: ${bad}`);
          const last = prev[p];
          if (last !== null && ((last.topspin && v.topspin) || (last.slice && v.slice) || (last.lob && v.lob))) {
            problems.push(`tick ${s.tick + 1} p${p}: a key held two ticks`);
          }
          if (v.topspin || v.slice || v.lob) presses += 1;
          prev[p] = v;
        }
      });
      expect(problems).toEqual([]);
      expect(presses).toBeGreaterThan(10);
    }
  });

  it('never reads s.rng (a Proxy that throws on any access stands in while it decides)', () => {
    const trap = new Proxy({}, {
      get: () => { throw new Error('CPU read s.rng'); },
      has: () => { throw new Error('CPU read s.rng'); },
      ownKeys: () => { throw new Error('CPU read s.rng'); },
      getOwnPropertyDescriptor: () => { throw new Error('CPU read s.rng'); },
      set: () => { throw new Error('CPU wrote s.rng'); },
    }) as ArcadeState['rng'];
    const s = createMatch(CONFIG, CPU_PLAYERS, 21);
    const cpus = [new ArcadeCpu(0, 12, 21), new ArcadeCpu(1, 4, 21)] as const;
    const events: ArcadeEvent[] = [];
    for (let n = 0; n < 5000; n++) {
      const real = s.rng;
      s.rng = trap;
      let inp: [PlayerInput, PlayerInput];
      try {
        inp = [cpus[0].input(s), cpus[1].input(s)];
      } finally {
        s.rng = real;
      }
      events.push(...step(s, inp));
    }
    expect(ofType(events, 'hit').length).toBeGreaterThan(10);
  });
});
