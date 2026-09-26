/**
 * Screenshots a Vite-served page once it signals `window.__shotReady === true`.
 *
 * Usage: node scripts/devshot.mjs <pagePath> <out.png> [--w 960] [--h 540] [--selector css] [--timeout 20000]
 *
 * <pagePath> is relative to the project root (e.g. tools/scratch/hello.html); omit a leading '/'
 * in Git Bash, which rewrites '/x' into a Windows path.
 *
 * Through the harness shared with scripts/artExport.mjs (scripts/lib/pageShot.mjs): starts a Vite dev
 * server on a free port, opens http://localhost:<port>/<pagePath> in the local Chrome via
 * playwright-core, screenshots the selector's element (or the full page) and prints the PNG path.
 * Page console errors go to stderr as `devshot: <line>`; a page-load, __shotReady or --selector
 * screenshot timeout also prints the whole page console transcript, and a failed launch prints the
 * errors of both launch routes. The browser and the server are closed on every path.
 * Exit codes: 0 ok, 1 failure/timeout, 2 bad usage.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openReadyPage, PageTimeoutError, startDevServer, withTimeoutTranscript } from './lib/pageShot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

/** Opens the page at `url` once ready and writes the selector's element, or the full page, to args.out. */
async function capture(browser, url, args) {
  const { page, transcript } = await openReadyPage(browser, url, {
    viewport: { width: args.w, height: args.h },
    timeout: args.timeout,
    tag: 'devshot',
  });
  await mkdir(dirname(args.out), { recursive: true });
  if (!args.selector) {
    await page.screenshot({ path: args.out, fullPage: true });
    return;
  }
  await withTimeoutTranscript(
    () => page.locator(args.selector).screenshot({ path: args.out, timeout: args.timeout }),
    `timed out after ${args.timeout} ms screenshotting ${args.selector} on ${url}`,
    transcript,
  );
}

async function shoot(args) {
  const { server, origin } = await startDevServer(ROOT);
  try {
    const browser = await launchChrome();
    try {
      await capture(browser, `${origin}/${args.pagePath.replace(/^\/+/, '')}`, args);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
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
  await shoot(args);
  console.log(args.out);
  process.exit(0);
} catch (err) {
  console.error(`devshot: ${err instanceof PageTimeoutError ? err.message : (err.stack ?? err)}`);
  process.exit(1);
}
