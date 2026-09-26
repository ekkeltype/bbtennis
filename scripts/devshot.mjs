/**
 * Screenshots a Vite-served page once it signals `window.__shotReady === true`.
 *
 * Usage: node scripts/devshot.mjs <pagePath> <out.png> [--w 960] [--h 540] [--selector css] [--timeout 20000]
 *
 * <pagePath> is relative to the project root (e.g. tools/scratch/hello.html); omit a leading '/'
 * in Git Bash, which rewrites '/x' into a Windows path.
 *
 * Starts a Vite dev server on a free port, opens http://localhost:<port>/<pagePath> in the local
 * Chrome via playwright-core, screenshots the selector's element (or the full page) and prints the
 * PNG path. Page console errors go to stderr. Exit codes: 0 ok, 1 failure/timeout, 2 bad usage.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, errors } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const USAGE = 'Usage: node scripts/devshot.mjs <pagePath> <out.png> [--w 960] [--h 540] [--selector css] [--timeout 20000]';

function parseArgs(argv) {
  const opts = { w: 960, h: 540, selector: null, timeout: 20000 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (!Object.hasOwn(opts, key) || value === undefined) throw new Error(`bad option ${arg}`);
    if (key === 'selector') {
      opts.selector = value;
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--${key} needs a positive integer, got ${value}`);
      opts[key] = n;
    }
  }
  if (positional.length !== 2) throw new Error('expected <pagePath> and <out.png>');
  const [pagePath, out] = positional;
  return { pagePath, out: resolve(out), ...opts };
}

async function launchChrome() {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return await chromium.launch({ executablePath: CHROME_PATH });
  }
}

async function shoot(args) {
  const consoleLines = [];
  let server = null;
  let browser = null;
  try {
    server = await createServer({
      root: ROOT,
      appType: 'mpa',
      server: { port: 0, forwardConsole: false },
      logLevel: 'warn',
      clearScreen: false,
    });
    await server.listen();
    const { port } = server.httpServer.address();
    const url = `http://localhost:${port}/${args.pagePath.replace(/^\/+/, '')}`;

    browser = await launchChrome();
    const context = await browser.newContext({ viewport: { width: args.w, height: args.h }, deviceScaleFactor: 1 });
    await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    const page = await context.newPage();
    page.on('console', (msg) => {
      const line = `[console.${msg.type()}] ${msg.text()}`;
      consoleLines.push(line);
      if (msg.type() === 'error') console.error(line);
    });
    page.on('pageerror', (err) => {
      const line = `[pageerror] ${err.stack ?? err.message}`;
      consoleLines.push(line);
      console.error(line);
    });

    const response = await page.goto(url, { timeout: args.timeout });
    if (response && !response.ok()) {
      console.error(`devshot: HTTP ${response.status()} for ${url}`);
      return 1;
    }
    try {
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: args.timeout });
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw err;
      console.error(`devshot: timed out after ${args.timeout} ms waiting for window.__shotReady on ${url}`);
      console.error(consoleLines.length ? consoleLines.join('\n') : '(no page console output)');
      return 1;
    }

    await mkdir(dirname(args.out), { recursive: true });
    if (args.selector) await page.locator(args.selector).screenshot({ path: args.out, timeout: args.timeout });
    else await page.screenshot({ path: args.out, fullPage: true });
    console.log(args.out);
    return 0;
  } finally {
    await browser?.close();
    await server?.close();
  }
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`devshot: ${err.message}\n${USAGE}`);
  process.exit(2);
}
try {
  process.exit(await shoot(args));
} catch (err) {
  console.error(`devshot: ${err.stack ?? err}`);
  process.exit(1);
}
