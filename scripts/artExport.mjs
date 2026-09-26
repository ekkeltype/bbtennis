/**
 * Art export (spec §6 Art QA): `npm run art:export`.
 *
 * Starts a Vite dev server on a free port, opens tools/art.html in the local Chrome via
 * playwright-core at a 1920×1080 viewport, waits for `window.__shotReady === true`, then screenshots
 * every `[data-shot]` element to artifacts/art/<name>.png (PNGs left there by earlier runs are
 * removed first) and prints the list.
 *
 * Exits 1 when the page logs a console error or throws (after writing the PNGs), when a section name
 * is missing, malformed or repeated, when there are no sections, when a section canvas is not shown
 * 1:1 at a whole-pixel position (its PNG would be resampled), or on a launch/load failure or timeout
 * (a timeout also prints the page's whole console transcript).
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, errors } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = 'tools/art.html';
const OUT_DIR = join(ROOT, 'artifacts', 'art');
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIEWPORT = { width: 1920, height: 1080 };
const TIMEOUT_MS = 60000;
/** Section names become file names: lowercase words joined by single hyphens. */
const SHOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Same launch routes as scripts/devshot.mjs: the Chrome channel, then the default install path. */
async function launchChrome() {
  let channelErr;
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (err) {
    channelErr = err;
  }
  try {
    return await chromium.launch({ executablePath: CHROME_PATH });
  } catch (pathErr) {
    throw new Error(
      `could not launch Chrome.\n--- via channel 'chrome':\n${channelErr.message}\n--- via executablePath ${CHROME_PATH}:\n${pathErr.message}`,
    );
  }
}

/** Problems with the page's `data-shot` names; empty when they are all usable, distinct file names. */
function nameProblems(names) {
  if (names.length === 0) return [`no [data-shot] sections on ${PAGE}`];
  const problems = [];
  const seen = new Set();
  for (const name of names) {
    if (name === null || !SHOT_NAME.test(name)) problems.push(`bad data-shot name ${JSON.stringify(name)}`);
    else if (seen.has(name)) problems.push(`duplicate data-shot name "${name}"`);
    seen.add(name);
  }
  return problems;
}

async function removeOldShots() {
  let files;
  try {
    files = await readdir(OUT_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(files.filter((f) => f.endsWith('.png')).map((f) => rm(join(OUT_DIR, f))));
}

async function exportArt() {
  const transcript = [];
  let pageErrors = 0;
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
    const url = `http://localhost:${port}/${PAGE}`;

    browser = await launchChrome();
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    const page = await context.newPage();
    page.on('console', (msg) => {
      const line = `[console.${msg.type()}] ${msg.text()}`;
      transcript.push(line);
      if (msg.type() !== 'error') return;
      pageErrors++;
      console.error(line);
    });
    page.on('pageerror', (err) => {
      const line = `[pageerror] ${err.stack ?? err.message}`;
      transcript.push(line);
      pageErrors++;
      console.error(line);
    });

    const timedOut = (what) => {
      console.error(`art:export: timed out after ${TIMEOUT_MS} ms ${what}`);
      console.error(transcript.length ? transcript.join('\n') : '(no page console output)');
      return 1;
    };

    let response;
    try {
      response = await page.goto(url, { timeout: TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw err;
      return timedOut(`loading ${url}`);
    }
    if (response && !response.ok()) {
      console.error(`art:export: HTTP ${response.status()} for ${url}`);
      return 1;
    }
    try {
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw err;
      return timedOut(`waiting for window.__shotReady on ${url}`);
    }

    const shots = page.locator('[data-shot]');
    const names = await shots.evaluateAll((els) => els.map((el) => el.getAttribute('data-shot')));
    const problems = nameProblems(names);
    const resampled = await page.$$eval('[data-shot] canvas', (canvases) =>
      canvases.filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width !== c.width || r.height !== c.height || !Number.isInteger(r.x) || !Number.isInteger(r.y);
      }).length,
    );
    if (resampled > 0) problems.push(`${resampled} canvas(es) not shown 1:1 on whole pixels, so PNGs would be resampled`);
    if (problems.length > 0) {
      for (const p of problems) console.error(`art:export: ${p}`);
      return 1;
    }

    await removeOldShots();
    await mkdir(OUT_DIR, { recursive: true });
    for (const [i, name] of names.entries()) {
      const file = join(OUT_DIR, `${name}.png`);
      await shots.nth(i).screenshot({ path: file, timeout: TIMEOUT_MS });
      console.log(relative(ROOT, file).replaceAll('\\', '/'));
    }
    console.log(`art:export: ${names.length} PNGs in ${relative(ROOT, OUT_DIR).replaceAll('\\', '/')}`);
    if (pageErrors > 0) {
      console.error(`art:export: the page logged ${pageErrors} error(s); see above`);
      return 1;
    }
    return 0;
  } finally {
    await browser?.close();
    await server?.close();
  }
}

try {
  process.exit(await exportArt());
} catch (err) {
  console.error(`art:export: ${err.stack ?? err}`);
  process.exit(1);
}
