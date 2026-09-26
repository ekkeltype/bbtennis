// Runs the full balance simulation (spec §6): `npx vitest run tests/sim` with BBT_SIM=1.
// Without BBT_SIM, tests/sim runs only its smoke subset (as part of `npm test`).
import { spawn } from 'node:child_process';

process.env.BBT_SIM = '1';

// One command string (no args array) so the shell finds npx on every platform without Node's
// warning about unescaped shell arguments.
const child = spawn('npx vitest run tests/sim', { stdio: 'inherit', shell: true, env: process.env });

child.on('error', (err) => {
  console.error(`test:sim could not start vitest: ${err.message}`);
  process.exit(1);
});
// A child killed by a signal has no exit code: report failure.
child.on('exit', (code) => process.exit(code ?? 1));
