import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** The commit being built (short hash), or 'dev' outside a git checkout: online Arcade players must run the same build. */
function buildId(): string {
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

process.env.VITE_BUILD_ID ??= buildId();

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: { main: 'index.html', arcade: 'arcade/index.html' },
    },
  },
  server: { port: 5173 },
});
