/** Thrown by a scenario that cannot run here: reported as skipped (a warning), not failed. */
export class SkipScenario extends Error {}

/** A named E2E scenario. */
export interface Scenario {
  name: string;
  run(): Promise<unknown>;
}

/** How a scenario went; `detail` is the skip reason or the failure's stack. */
export interface ScenarioResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  ms: number;
}

/** Runs every scenario in order; a failure or skip never stops the next. */
export function runScenarios(scenarios: readonly Scenario[], log?: (line: string) => void): Promise<ScenarioResult[]>;

/** 1 when any scenario failed, else 0. */
export function exitCode(results: readonly ScenarioResult[]): 0 | 1;

/** One line per scenario, then the totals. */
export function summary(results: readonly ScenarioResult[]): string[];
