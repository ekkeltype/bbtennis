// Runs the full balance simulations with BBT_SIM=1: the typing game's (spec §6, tests/sim) and the
// Arcade's (Arcade spec §7, tests/arcade/balance.test.ts), as `npx vitest run tests/sim
// tests/arcade/balance.test.ts`. Without BBT_SIM, both run only their smoke subsets (as part of `npm test`).
import { spawn } from 'node:child_process';

process.env.BBT_SIM = '1';

// One command string (no args array) so the shell finds npx on every platform without Node's
// warning about unescaped shell arguments.
const child = spawn('npx vitest run tests/sim tests/arcade/balance.test.ts', { stdio: 'inherit', shell: true, env: process.env });

child.on('error', (err) => {
  console.error(`test:sim could not start vitest: ${err.message}`);
  process.exit(1);
});
// A child killed by a signal has no exit code: report failure.
child.on('exit', (code) => process.exit(code ?? 1));
