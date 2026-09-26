/** Runs the E2E scenarios (scripts/e2e.mjs) one after another and reports how each went. */

/** Thrown by a scenario that cannot run here (the online one without a broker): a warning, not a failure. */
export class SkipScenario extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipScenario';
  }
}

/**
 * Runs each `{ name, run }` in order, logging `> name` as it starts. A scenario that throws fails
 * (SkipScenario: is skipped) without stopping the ones after it. Resolves to one result per scenario:
 * `{ name, status: 'pass' | 'fail' | 'skip', detail, ms }`, `detail` being the reason or stack.
 */
export async function runScenarios(scenarios, log = console.log) {
  const results = [];
  for (const { name, run } of scenarios) {
    log(`> ${name}`);
    const t0 = Date.now();
    let status = 'pass';
    let detail = '';
    try {
      await run();
    } catch (err) {
      status = err instanceof SkipScenario ? 'skip' : 'fail';
      detail = err instanceof SkipScenario ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
    results.push({ name, status, detail, ms: Date.now() - t0 });
  }
  return results;
}

/** The process exit code: 1 when any scenario failed, else 0 (a skip is only a warning). */
export function exitCode(results) {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

const LABEL = { pass: 'PASS', skip: 'WARN', fail: 'FAIL' };

/** One line per scenario (a skip is a WARN with its reason, a failure carries its detail), then the totals. */
export function summary(results) {
  const lines = results.map((r) => {
    const head = `${LABEL[r.status]}  ${r.name} (${(r.ms / 1000).toFixed(1)} s)`;
    if (r.status === 'pass') return head;
    return `${head}: ${r.status === 'skip' ? 'skipped: ' : ''}${r.detail}`;
  });
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push(`${count('pass')} passed, ${count('skip')} skipped, ${count('fail')} failed`);
  return lines;
}
