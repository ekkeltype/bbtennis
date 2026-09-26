import { describe, expect, it } from 'vitest';
import { VirtualScheduler } from '../../src/game/clock';
import { Attract } from '../../src/ui/attract';

const STEP = 250;

describe('Attract', () => {
  it('runs a spectator CPU-vs-CPU Normal tiebreak between two Green-to-Black levels', () => {
    const s = new VirtualScheduler();
    const attract = new Attract(s, () => 0.4);
    const vm = attract.frame(0);
    expect(vm.viewer).toBe('spectator');
    expect(vm.pub.config.format).toBe('tiebreak');
    expect(vm.pub.config.pace).toBe('normal');
    for (const p of vm.pub.players) {
      expect(p.kind).toBe('cpu');
      expect(p.cpuLevel).toBeGreaterThanOrEqual(6);
      expect(p.cpuLevel).toBeLessThanOrEqual(12);
    }
  });

  it('keeps one demo until it is over, then starts a new one 2 s after MATCH_OVER', () => {
    const s = new VirtualScheduler();
    const attract = new Attract(s);
    const first = attract.session;
    let vm = attract.frame(0);
    for (let i = 0; i < 20_000 && vm.pub.status !== 'over'; i++) {
      s.advance(STEP);
      vm = attract.frame(STEP);
      expect(attract.session).toBe(first);
    }
    expect(vm.pub.status).toBe('over');
    s.advance(1900);
    attract.frame(1900);
    expect(attract.session).toBe(first);
    s.advance(100);
    const next = attract.frame(100);
    expect(attract.session).not.toBe(first);
    expect(next.pub.status).toBe('playing');
  }, 60_000);

  it('shown again after minutes away (a match, Options), it goes on where it was: no catching up on the time it was not shown', () => {
    const s = new VirtualScheduler();
    const attract = new Attract(s);
    let vm = attract.frame(0);
    for (let i = 0; i < 40; i++) {
      s.advance(STEP);
      vm = attract.frame(STEP);
    }
    const before = { point: vm.pub.pointNo, score: structuredClone(vm.pub.score) };
    s.advance(5 * 60_000);
    const back = attract.frame(16);
    expect(back.pub.status).toBe('playing');
    expect(back.pub.pointNo - before.point).toBeLessThanOrEqual(1);
    expect(back.pub.score.setGames).toEqual(before.score.setGames);
    expect(back.events.filter((e) => e.type === 'point').length).toBeLessThanOrEqual(1);
  });

  it('a demo that was over when it was hidden is replaced on its return, not raced through', () => {
    const s = new VirtualScheduler();
    const attract = new Attract(s);
    const first = attract.session;
    let vm = attract.frame(0);
    for (let i = 0; i < 20_000 && vm.pub.status !== 'over'; i++) {
      s.advance(STEP);
      vm = attract.frame(STEP);
    }
    s.advance(5 * 60_000);
    const back = attract.frame(16);
    expect(attract.session).not.toBe(first);
    expect(back.pub.status).toBe('playing');
    expect(back.pub.pointNo).toBeLessThanOrEqual(1);
  }, 60_000);

  it('stop() drops the demo and the next frame starts a fresh one', () => {
    const s = new VirtualScheduler();
    const attract = new Attract(s);
    const first = attract.session;
    attract.stop();
    attract.frame(0);
    expect(attract.session).not.toBe(first);
  });
});
