/**
 * Art export (spec §6 Art QA): `npm run art:export`.
 *
 * Through the harness shared with scripts/devshot.mjs (scripts/lib/pageShot.mjs): starts a Vite dev
 * server on a free port, opens tools/art.html in the local Chrome via playwright-core at a 1920×1080
 * viewport, waits for `window.__shotReady === true`, then screenshots every `[data-shot]` element to
 * artifacts/art/<name>.png (PNGs left there by earlier runs are removed first) and prints the list.
 * The browser and the server are closed on every path.
 *
 * Exits 1 when the page logs a console error or throws (after writing the PNGs), when a section name
 * is missing, malformed or repeated, when there are no sections, when a section canvas is not shown
 * 1:1 at a whole-pixel position (its PNG would be resampled), or on a launch/load failure or timeout
 * (a timeout also prints the page's whole console transcript).
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openReadyPage, PageTimeoutError, startDevServer } from './lib/pageShot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = 'tools/art.html';
const OUT_DIR = join(ROOT, 'artifacts', 'art');
const VIEWPORT = { width: 1920, height: 1080 };
const TIMEOUT_MS = 60000;
/** Section names become file names: lowercase words joined by single hyphens. */
const SHOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/** Opens the art page at `url` once ready and writes one PNG per section; returns the exit code. */
async function shootSections(browser, url) {
  const opened = await openReadyPage(browser, url, { viewport: VIEWPORT, timeout: TIMEOUT_MS, tag: 'art:export' });
  const shots = opened.page.locator('[data-shot]');
  const names = await shots.evaluateAll((els) => els.map((el) => el.getAttribute('data-shot')));
  const problems = nameProblems(names);
  const resampled = await opened.page.$$eval('[data-shot] canvas', (canvases) =>
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
  if (opened.errorCount > 0) {
    console.error(`art:export: the page logged ${opened.errorCount} error(s); see above`);
    return 1;
  }
  return 0;
}

async function exportArt() {
  const { server, origin } = await startDevServer(ROOT);
  try {
    const browser = await launchChrome();
    try {
      return await shootSections(browser, `${origin}/${PAGE}`);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

try {
  process.exit(await exportArt());
} catch (err) {
  console.error(`art:export: ${err instanceof PageTimeoutError ? err.message : (err.stack ?? err)}`);
  process.exit(1);
}
