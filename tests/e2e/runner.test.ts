import { describe, expect, it } from 'vitest';
import { exitCode, runScenarios, SkipScenario, summary, type ScenarioResult } from './runner.mjs';

describe('runScenarios', () => {
  it('runs every scenario in order, whether an earlier one passed, failed or was skipped', async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const results = await runScenarios(
      [
        { name: 'boot', run: async () => void ran.push('boot') },
        {
          name: 'menus',
          run: async () => {
            ran.push('menus');
            throw new Error('no title');
          },
        },
        {
          name: 'online',
          run: async () => {
            ran.push('online');
            throw new SkipScenario('broker unreachable');
          },
        },
        { name: 'last', run: async () => void ran.push('last') },
      ],
      (line) => lines.push(line),
    );
    expect(ran).toEqual(['boot', 'menus', 'online', 'last']);
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['boot', 'pass'],
      ['menus', 'fail'],
      ['online', 'skip'],
      ['last', 'pass'],
    ]);
    expect(results[1]!.detail).toContain('no title');
    expect(results[2]!.detail).toBe('broker unreachable');
    expect(results.every((r) => Number.isFinite(r.ms) && r.ms >= 0)).toBe(true);
    expect(lines.filter((l) => l.startsWith('>'))).toEqual(['> boot', '> menus', '> online', '> last']);
  });

  it('reports a thrown non-Error as a failure too', async () => {
    const [r] = await runScenarios([{ name: 'odd', run: () => Promise.reject('just a string') }], () => {});
    expect(r).toMatchObject({ name: 'odd', status: 'fail', detail: 'just a string' });
  });
});

describe('exitCode', () => {
  const result = (status: ScenarioResult['status']): ScenarioResult => ({ name: status, status, detail: '', ms: 1 });

  it('is 0 when every scenario passed or was skipped, 1 when any failed', () => {
    expect(exitCode([])).toBe(0);
    expect(exitCode([result('pass'), result('skip')])).toBe(0);
    expect(exitCode([result('pass'), result('fail'), result('skip')])).toBe(1);
  });
});

describe('summary', () => {
  it('gives one line per scenario, with a warning for a skip and the reason for a skip or failure', () => {
    const lines = summary([
      { name: '1 boot', status: 'pass', detail: '', ms: 3200 },
      { name: '5 online', status: 'skip', detail: 'broker unreachable', ms: 21000 },
      { name: '4 match', status: 'fail', detail: 'Error: timed out\n    at stack', ms: 1500 },
    ]);
    expect(lines).toEqual([
      'PASS  1 boot (3.2 s)',
      'WARN  5 online (21.0 s): skipped: broker unreachable',
      'FAIL  4 match (1.5 s): Error: timed out\n    at stack',
      '1 passed, 1 skipped, 1 failed',
    ]);
  });
});
