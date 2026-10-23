// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { simulateMatch } from '../../../src/arcade/core/sim';
import type { ArcadeState, ArcadeStats, PlayerId } from '../../../src/arcade/core/types';
import { resultsScreen, type OnlineResults } from '../../../src/arcade/ui/screens/results';
import { setLine } from '../../../src/core/scoring';
import { Router } from '../../../src/ui/router';

let root: HTMLElement;
let router: Router;
let result: ArcadeState;

function show(viewer: PlayerId, online?: OnlineResults) {
  const ctx = { rematch: vi.fn(), quitMatch: vi.fn() };
  router.register('results', resultsScreen(ctx));
  router.go('results', { result, viewer, online });
  return ctx;
}

const title = (): string => root.querySelector('.panel-title')?.textContent ?? '';

/** The cells of the stats row labelled `label`. */
function statCells(label: string): string[] {
  const tr = [...root.querySelectorAll('table.stats tbody tr')].find((r) => r.querySelector('th')?.textContent === label);
  if (!tr) throw new Error(`no stats row ${label}`);
  return [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '');
}

const buttonNamed = (text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
};

beforeAll(() => {
  result = simulateMatch({ format: 'short', deuceRule: 'advantage', surface: 'hard', pace: 'normal' }, [4, 10], 2026).state;
});

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  router = new Router(root);
});

afterEach(() => {
  router.dispose();
  vi.restoreAllMocks();
});

describe('Results screen', () => {
  it('is built from a finished match with real stats', () => {
    expect(result.status).toBe('over');
    expect(result.winner).not.toBeNull();
    const [a, b] = result.stats;
    expect(a.pointsWon + b.pointsWon).toBeGreaterThan(10);
    expect(a.perfectHits + b.perfectHits).toBeGreaterThan(0);
    expect(result.longestRally).toBeGreaterThan(1);
  });

  it('names the winner: YOU WIN! for the viewer, else the winner by name', () => {
    const w = result.winner!;
    show(w);
    expect(root.querySelector('.panel-title')?.textContent).toBe('YOU WIN!');
    show(w === 0 ? 1 : 0);
    expect(root.querySelector('.panel-title')?.textContent).toBe(`${result.players[w].name.toUpperCase()} WINS`);
  });

  it('shows the set scores per player', () => {
    show(0);
    const line = setLine(result.score);
    const rows = [...root.querySelectorAll('table.score tbody tr')];
    expect(rows.length).toBe(2);
    rows.forEach((tr, p) => {
      expect(tr.querySelector('th')?.textContent).toBe(result.players[p as PlayerId].name.toUpperCase());
      const cells = [...tr.querySelectorAll('td')].map((td) => td.firstChild?.textContent);
      expect(cells).toEqual(line[p as PlayerId].map((c) => String(c.value)));
    });
    expect(root.querySelector('table.score tr.won th')?.textContent).toBe(result.players[result.winner!].name.toUpperCase());
  });

  it.each<[string, keyof ArcadeStats]>([
    ['POINTS WON', 'pointsWon'],
    ['ACES', 'aces'],
    ['DOUBLE FAULTS', 'doubleFaults'],
    ['WINNERS', 'winners'],
    ['ERRORS', 'errors'],
    ['PERFECT HITS', 'perfectHits'],
  ])('shows %s for both players', (label, key) => {
    show(0);
    expect(statCells(label)).toEqual([String(result.stats[0][key]), String(result.stats[1][key])]);
  });

  it('shows the fastest serves in km/h and the longest rally across both columns', () => {
    show(0);
    const kmh = (p: PlayerId): string => {
      const v = result.stats[p].fastestServeKmh;
      return v > 0 ? `${Math.round(v)} KM/H` : '-';
    };
    expect(statCells('FASTEST SERVE')).toEqual([kmh(0), kmh(1)]);
    expect(statCells('LONGEST RALLY')).toEqual([`${result.longestRally} SHOTS`]);
  });

  it('Rematch asks for a rematch; Menu and Esc leave the match', () => {
    const ctx = show(0);
    buttonNamed('REMATCH').click();
    expect(ctx.rematch).toHaveBeenCalledOnce();
    buttonNamed('MENU').click();
    expect(ctx.quitMatch).toHaveBeenCalledOnce();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ctx.quitMatch).toHaveBeenCalledTimes(2);
  });
});

describe('Results screen online (online spec §5)', () => {
  const ONLINE: OnlineResults = { canRematch: true, forfeitBy: null, opponentGone: null, endedBy: null, lost: false };

  it('a played-out match reads as vs CPU; Rematch asks the opponent and waits', () => {
    const ctx = show(result.winner!, ONLINE);
    expect(title()).toBe('YOU WIN!');
    const rematch = buttonNamed('REMATCH');
    expect(rematch.disabled).toBe(false);
    rematch.click();
    expect(ctx.rematch).toHaveBeenCalledTimes(1);
    expect(rematch.textContent).toBe('WAITING FOR OPPONENT...');
    expect(rematch.disabled).toBe(true);
  });

  it('a forfeit names who forfeited, and the other player won', () => {
    show(0, { ...ONLINE, forfeitBy: 1 });
    expect(title()).toBe(`${result.players[1].name.toUpperCase()} FORFEITS`);
    expect(root.querySelector('.panel.results')?.classList.contains('win')).toBe(true);
    expect(root.querySelector('table.score tbody tr.won th')?.textContent).toBe(result.players[0].name.toUpperCase());
  });

  it('an opponent who left mid-match is the heading; Rematch is disabled and Menu is the main action', () => {
    show(0, { canRematch: false, forfeitBy: null, opponentGone: 'left', endedBy: 'left', lost: false });
    expect(title()).toBe('OPPONENT LEFT');
    // The one still there is shown as the winner.
    expect(root.querySelector('.panel.results')?.classList.contains('win')).toBe(true);
    expect(root.querySelector('table.score tbody tr.won th')?.textContent).toBe(result.players[0].name.toUpperCase());
    expect(root.querySelector('.opponent-gone')).toBeNull();
    expect(buttonNamed('REMATCH').disabled).toBe(true);
    expect(buttonNamed('MENU').classList.contains('primary')).toBe(true);
  });

  it('a match cut short shows the set it stopped in: the games, or the points of a Tiebreak-format match', () => {
    const full = result;
    try {
      result = { ...structuredClone(full), status: 'playing', winner: null };
      result.score = { ...result.score, setGames: [[6, 4]], setTiebreaks: [null], games: [2, 3] };
      show(0, { ...ONLINE, forfeitBy: 0 });
      const rows = () => [...root.querySelectorAll('table.score tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
      expect([...root.querySelectorAll('table.score thead th')].map((th) => th.textContent)).toEqual(['', 'SET 1', 'SET 2']);
      expect(rows()).toEqual([['6', '2'], ['4', '3']]);
      result.score = { ...result.score, format: 'tiebreak', setGames: [], setTiebreaks: [], games: [0, 0], points: [5, 3] };
      show(0, { ...ONLINE, forfeitBy: 1 });
      expect([...root.querySelectorAll('table.score thead th')].map((th) => th.textContent)).toEqual(['', 'POINTS']);
      expect(rows()).toEqual([['5'], ['3']]);
    } finally {
      result = full;
    }
  });

  it('a match this side lost the connection to says so, with Rematch off', () => {
    show(0, { canRematch: false, forfeitBy: null, opponentGone: null, endedBy: null, lost: true });
    expect(title()).toBe('CONNECTION LOST');
    expect(buttonNamed('REMATCH').disabled).toBe(true);
    expect(buttonNamed('MENU').classList.contains('primary')).toBe(true);
  });

  it('an opponent who dropped after the match gets a note under the stats', () => {
    show(result.winner!, { canRematch: false, forfeitBy: null, opponentGone: 'disconnect', endedBy: null, lost: false });
    expect(title()).toBe('YOU WIN!');
    expect(root.querySelector('.opponent-gone')?.textContent).toBe('OPPONENT DISCONNECTED');
    expect(buttonNamed('REMATCH').disabled).toBe(true);
  });
});
