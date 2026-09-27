import { describe, expect, it } from 'vitest';
import { bannerFor, Hud, meterLevels, scoreRows, serveClockSeconds, speedReadout } from '../../src/render/hud';
import { bannerSamples, readoutSample, scoreboardSamples, serveClockSamples } from '../../tools/art/hudStates';

const PREFS = { largeWords: false, reduceEffects: false, showWpm: true };

describe('HUD samples', () => {
  it('scoreboards: each sample shows its score, sets and games', () => {
    const rows = scoreboardSamples().map((s) => scoreRows(s.frame.pub));
    const shown = rows.map(([a, b]) => ({ points: [a.points, b.points], games: [a.games, b.games], sets: [a, b].map((r) => r.setCells.map((c) => c.value)) }));
    expect(shown).toEqual([
      { points: ['0', '0'], games: [0, 0], sets: [[], []] },
      { points: ['6', '5'], games: [0, 0], sets: [[], []] },
      { points: ['15', '40'], games: [2, 1], sets: [[], []] },
      { points: ['40', '40'], games: [3, 3], sets: [[], []] },
      { points: ['', 'AD'], games: [3, 3], sets: [[], []] },
      { points: ['0', '40'], games: [2, 2], sets: [[4, 3], [2, 5]] },
      // A decided Tiebreak-format match: its one set column shows the tiebreak points.
      { points: ['0', '0'], games: [0, 0], sets: [[7], [5]] },
    ]);
  });

  it('scoreboards: the serve dot on either row, none once the match is over, every belt and a 12-letter name', () => {
    const rows = scoreboardSamples().map((s) => scoreRows(s.frame.pub));
    const serving = rows.map(([a, b]) => (a.serving ? 0 : b.serving ? 1 : null));
    expect(serving.slice(0, -1)).toContain(0);
    expect(serving.slice(0, -1)).toContain(1);
    expect(serving.at(-1)).toBeNull();
    expect(new Set(rows.map(([, b]) => b.belt)).size).toBeGreaterThanOrEqual(5);
    expect(Math.max(...rows.flat().map((r) => r.name.length))).toBe(12);
  });

  it('scoreboards: some sample shows a full meter and some a part-filled one', () => {
    const levels = scoreboardSamples().map((s) => meterLevels(s.frame));
    expect(levels.some((l) => l !== null && l.includes(4))).toBe(true);
    expect(levels.some((l) => l !== null && l.some((n) => n > 0 && n < 4))).toBe(true);
  });

  it('serve clocks: 30, 10, 5 (the last seconds) and 1 during PRE_SERVE', () => {
    const samples = serveClockSamples();
    expect(samples.map((s) => serveClockSeconds(s.frame))).toEqual([30, 10, 5, 1]);
    for (const s of samples) expect(s.frame.view?.phase).toBe('preServe');
  });

  it('readouts: the shot speed of a rally and the WPM of the viewer’s last word', () => {
    const { frame } = readoutSample();
    expect(speedReadout(frame)?.alpha).toBe(1);
    const hud = new Hud();
    hud.update(frame);
    const r = hud.readouts(frame, PREFS);
    expect(r.speed?.text).toMatch(/^\d+ KM\/H$/);
    expect(r.wpm).toMatch(/^\d+ WPM$/);
  });

  it('banners: every call, the lead-in sequences, a slide-in, the situations and the champion', () => {
    const banners = bannerSamples().map((s) => bannerFor(s.frame));
    expect(banners.map((b) => b?.lines.map((l) => l.text))).toEqual([
      ['ALEX TO SERVE'],
      ['FAULT', 'BALL DROPPED'],
      ['FAULT', 'TIME VIOLATION'],
      ['FAULT', 'NET'],
      ['DOUBLE FAULT'],
      ['ACE!'],
      ['WINNER', 'GAME ALEX'],
      ['OUT', 'GAME BRUNO', 'SET BRUNO'],
      ['NET'],
      ['WINNER'],
      ['MATCH POINT'],
      ['SET POINT'],
      ['BREAK POINT'],
      ['DEUCE'],
      ['GAME, SET AND MATCH', 'ALEX'],
    ]);
    expect(banners.map((b) => b?.small)).toEqual([...Array<boolean>(10).fill(false), true, true, true, true, false]);
    const settled = banners.filter((_, i) => i !== 9);
    for (const b of settled) for (const l of b!.lines) expect(l.ageMs).toBeGreaterThanOrEqual(300);
    expect(banners[9]!.ageMs).toBeLessThan(180);
    for (const b of banners) if (b!.leftMs !== null) expect(b!.leftMs).toBeGreaterThanOrEqual(250);
  });
});
