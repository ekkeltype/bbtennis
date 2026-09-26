/**
 * `npm run e2e` (plan Task 23, spec §6): builds the game with `vite build`, serves dist/ with
 * `vite preview`, and plays it in the local Chrome (scripts/lib/pageShot.mjs) with `?e2e=1`, whose
 * `window.__bbt` hooks show what to type. Scenarios: (1) boot → gate → title; (2) every screen at
 * 960×540 and 1920×1080; (3) Training lesson 1 by keyboard; (4) a full vs-CPU tiebreak typed at 90 ms
 * per key; (5) best effort, two pages playing 2 points online over the real PeerJS broker. Screenshots
 * go to artifacts/e2e/ (and the build to dist/). Exits 1 when a scenario fails (a page logging an error
 * fails its scenario) or the run cannot start; the online scenario is skipped with a warning when the
 * broker is unreachable. The browser and the server are always closed.
 */
import { deepStrictEqual, ok } from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { exitCode, runScenarios, SkipScenario, summary } from '../tests/e2e/runner.mjs';
import { hardestOption, momentOf, nextKey, pageSnapshot } from '../tests/e2e/typist.mjs';
import { launchChrome, openReadyPage } from './lib/pageShot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'artifacts', 'e2e');
const SMALL = { width: 960, height: 540 };
const LARGE = { width: 1920, height: 1080 };
/** Delay after each typed key. */
const KEY_MS = 90;
/** Delay between looks at the match while there is nothing to type. */
const POLL_MS = 25;
/** How long a point call shows before its screenshot: its banner slides in and its lines join it (≥ 2 s call). */
const BANNER_MS = 700;
/** Longest wait for a page, a screen or a match state. */
const STEP_MS = 15_000;
/** Longest wait for a game code or a connection: the app gives up on the broker after 20 s. */
const NET_MS = 30_000;
/** Longest the first Training point, the two online points and the full tiebreak may take. */
const POINT_MS = 90_000;
const ONLINE_MS = 3 * 60_000;
const MATCH_MS = 8 * 60_000;
/** The host lobby's status when the broker cannot be reached (src/net/netErrors.ts errorText 'broker'). */
const BROKER_DOWN = "Can't reach the connection server";
/** Training's first serve words and coach texts (src/game/training.ts TRAINING_WORDS.serve[0], COACH). */
const TRAINING_SERVE = ['cat', 'garden', 'strawberry'];
const COACH_TOSS = 'PRESS SPACE TO TOSS THE BALL';
const COACH_SERVE = 'TYPE ANY OF THE THREE WORDS TO SERVE';
/** Every screen by its `?screen=` name, with the element that shows it is up. */
const SCREENS = [
  ['gate', '.screen.gate'],
  ['title', '.screen.title'],
  ['mainMenu', '.screen.main-menu'],
  ['cpuSetup', '.panel.setup'],
  ['customize', '.panel.customize'],
  ['options', '.panel.options'],
  ['howTo', '.panel.how-to'],
  ['host', '.panel.lobby.host'],
  ['join', '.panel.lobby.join'],
  ['match', '.screen.play.cpu'],
  ['training', '.screen.play.training'],
  ['pause', '.panel.pause-panel'],
  ['results', '.panel.results'],
];

const log = (line) => console.log(`[e2e] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shots = [];

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  shots.push(`${name}.png`);
}

/**
 * Opens `/?<search>` in a new `viewport`-sized context once the app is ready, runs `use(page)`, and
 * closes the context. Console errors fail the page unless `errorsOk()` says they were expected.
 */
async function withPage(env, { search, viewport = SMALL, tag, errorsOk = () => false }, use) {
  const tab = await openReadyPage(env.browser, `${env.origin}/?${search}`, { viewport, timeout: STEP_MS, tag });
  try {
    const out = await use(tab.page);
    if (tab.errorCount > 0 && !errorsOk()) {
      const errors = tab.transcript.filter((l) => l.startsWith('[console.error]') || l.startsWith('[pageerror]'));
      throw new Error(`${tag}: the page logged ${tab.errorCount} error(s):\n${errors.join('\n')}`);
    }
    return out;
  } finally {
    await tab.page.context().close();
  }
}

const visible = (page, selector, timeout = STEP_MS) => page.locator(selector).first().waitFor({ state: 'visible', timeout });

/** Clicks the menu button labelled exactly `label` once it is visible and enabled. */
const click = (page, label) => page.locator('#ui button', { hasText: new RegExp(`^${label}$`) }).first().click({ timeout: STEP_MS });

/** Distinct colours among every 7th pixel of the game canvas: a drawn scene has many. */
const canvasColours = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('game');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 28) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });

/** Polls the page's match until `pred(snapshot)`; resolves to that snapshot. */
async function waitSnap(page, pred, what, timeout = STEP_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = await page.evaluate(pageSnapshot);
    if (pred(s)) return s;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}; last: ${JSON.stringify(s)}`);
    await sleep(POLL_MS);
  }
}

/**
 * Types on `page` as its player until `done(snapshot)`: the typist's next key every KEY_MS (options
 * picked by `choose`, by default the medium one), and a screenshot `shotNames[moment]` the first time
 * each moment shows. Resolves to the moments taken.
 */
async function play(page, done, { shotNames = {}, choose, timeout, what }) {
  const taken = new Set();
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = await page.evaluate(pageSnapshot);
    const m = momentOf(s);
    if (m !== null && shotNames[m] !== undefined && !taken.has(m)) {
      taken.add(m);
      if (m === 'pointCall') await sleep(BANNER_MS);
      await shot(page, shotNames[m]);
    }
    if (done(s)) return taken;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}; last: ${JSON.stringify(s)}`);
    const key = nextKey(s, choose);
    if (key === null) {
      await sleep(POLL_MS);
    } else {
      await page.keyboard.press(key);
      await sleep(KEY_MS);
    }
  }
}

/** (1) The page boots to the start gate; a click opens the title over the attract demo. */
async function bootScenario(env) {
  await withPage(env, { search: 'e2e=1', tag: 'boot' }, async (page) => {
    await visible(page, '.screen.gate');
    await shot(page, '1-gate');
    await page.locator('.screen.gate').click();
    await visible(page, '.screen.title');
    await page.waitForTimeout(500);
    const colours = await canvasColours(page);
    ok(colours >= 16, `the title's attract demo shows only ${colours} colours`);
    await shot(page, '1-title');
  });
}

/** (2) Every screen through the dev `?screen=` jump, at both sizes. */
async function screensScenario(env) {
  for (const viewport of [SMALL, LARGE]) {
    for (const [name, selector] of SCREENS) {
      let brokerDown = false;
      const tag = `${name}-${viewport.width}x${viewport.height}`;
      await withPage(env, { search: `e2e=1&screen=${name}`, viewport, tag, errorsOk: () => brokerDown }, async (page) => {
        await visible(page, selector);
        if (name === 'host') brokerDown = (await hostCode(page)) === null;
        await shot(page, `2-${tag}`);
      });
    }
  }
}

/** (3) Training by keyboard alone: menus by Enter, then lesson 1 (toss, serve a word) through the end of its point. */
async function trainingScenario(env) {
  await withPage(env, { search: 'e2e=1', tag: 'training' }, async (page) => {
    await visible(page, '.screen.gate');
    await page.keyboard.press('Enter');
    await visible(page, '.screen.title');
    await page.keyboard.press('Enter');
    await visible(page, '.screen.main-menu');
    await page.keyboard.press('Enter');
    await visible(page, '.screen.play.training');

    const pre = await waitSnap(page, (s) => s.status === 'preServe', "the trainee's first PRE_SERVE");
    deepStrictEqual([pre.me, pre.owner, pre.coach], [0, 0, COACH_TOSS]);
    await shot(page, '3-training-preServe');
    await page.keyboard.press('Space');
    const toss = await waitSnap(page, (s) => s.status === 'toss', 'the toss');
    deepStrictEqual([toss.words?.words, toss.coach], [TRAINING_SERVE, COACH_SERVE]);

    await play(page, (s) => s.points >= 1, {
      shotNames: { toss: '3-training-toss', pointCall: '3-training-pointCall' },
      timeout: POINT_MS,
      what: 'the end of the first point (lesson 1)',
    });
    const served = await page.evaluate(() => window.__bbt.view().pub.stats[0].wordsCompleted);
    ok(served >= 1, 'the trainee never completed a word');
  });
}

/** (4) Menus by mouse to a vs-CPU match on the first-visit defaults, typed through to Results. */
async function matchScenario(env) {
  await withPage(env, { search: 'e2e=1', tag: 'match' }, async (page) => {
    await page.locator('.screen.gate').click();
    await click(page, 'PRESS ENTER');
    await click(page, 'PLAY VS CPU');
    await visible(page, '.panel.setup');
    await click(page, 'START');
    await visible(page, '.screen.play.cpu');
    const setup = await page.evaluate(() => {
      const { config, players } = window.__bbt.view().pub;
      return [config.format, config.pace, players[1].kind, players[1].cpuLevel];
    });
    deepStrictEqual(setup, ['tiebreak', 'relaxed', 'cpu', 0], 'expected a White-belt Relaxed tiebreak');

    const moments = ['preServe', 'toss', 'chase', 'choice', 'pointCall'];
    const taken = await play(page, (s) => s.status === 'over', {
      shotNames: Object.fromEntries(moments.map((m) => [m, `4-match-${m}`])),
      timeout: MATCH_MS,
      what: 'the end of the match',
    });
    await visible(page, '.panel.results');
    await page.waitForTimeout(300);
    await shot(page, '4-match-results');
    const missed = moments.filter((m) => !taken.has(m));
    deepStrictEqual(missed, [], 'match moments never seen');
    const end = await page.evaluate(() => {
      const pub = window.__bbt.view().pub;
      return { status: pub.status, winner: pub.winner, won: pub.stats.map((s) => s.pointsWon) };
    });
    const [a, b] = end.won;
    ok(end.status === 'over' && end.winner !== null, `the match is not over: ${JSON.stringify(end)}`);
    ok(Math.max(a, b) >= 7 && Math.abs(a - b) >= 2, `not a finished tiebreak: points ${a}-${b}`);
    log(`match over: player ${end.winner} won the tiebreak ${Math.max(a, b)}-${Math.min(a, b)}`);
  });
}

/**
 * Waits for the host lobby's game code; resolves to it, or to null when the lobby could not reach the
 * broker. Throws on any other lobby failure, or when neither shows in NET_MS.
 */
async function hostCode(page) {
  const lobby = page.locator('.panel.lobby.host');
  const retry = lobby.locator('button', { hasText: /^RETRY$/ });
  await page.waitForFunction(
    () => {
      const code = document.querySelector('.lobby.host .code')?.textContent ?? '';
      const failed = [...document.querySelectorAll('.lobby.host button')].find((b) => b.textContent === 'RETRY');
      return /^[A-Z2-9]{5}$/.test(code) || failed?.hidden === false;
    },
    null,
    { timeout: NET_MS },
  );
  if (await retry.isHidden()) return lobby.locator('.code').textContent();
  const status = await lobby.locator('.status').textContent();
  if (status === BROKER_DOWN) return null;
  throw new Error(`the host lobby failed: ${status}`);
}

/** Waits until the guest is in the host's lobby; SkipScenario when it could not reach the broker. */
async function joinLobby(page) {
  const lobby = page.locator('.panel.lobby.join');
  await page.waitForFunction(
    () => {
      const name = document.querySelector('.lobby.join .opponent .name')?.textContent ?? '';
      const failed = [...document.querySelectorAll('.lobby.join button')].find((b) => b.textContent === 'RETRY');
      return name !== '' || failed?.hidden === false;
    },
    null,
    { timeout: NET_MS },
  );
  if (await lobby.locator('.opponent').isVisible()) return;
  const status = await lobby.locator('.status').textContent();
  if (status === BROKER_DOWN) throw new SkipScenario(`the guest cannot reach the PeerJS broker ("${status}")`);
  throw new Error(`joining failed: ${status}`);
}

/**
 * (5) Best effort online: host → code; the guest names itself GUEST in Customize and joins by the invite
 * link → both see each other → both Ready → 2 points typed on both pages.
 */
async function onlineScenario(env) {
  await withPage(env, { search: 'e2e=1', tag: 'host' }, async (host) => {
    await host.locator('.screen.gate').click();
    await click(host, 'PRESS ENTER');
    await click(host, 'PLAY ONLINE');
    await click(host, 'HOST GAME');
    await visible(host, '.panel.lobby.host');
    const code = await hostCode(host);
    if (code === null) throw new SkipScenario(`the host cannot reach the PeerJS broker ("${BROKER_DOWN}")`);
    log(`game code ${code}`);

    await withPage(env, { search: 'e2e=1', tag: 'guest' }, async (guest) => {
      await guest.locator('.screen.gate').click();
      await click(guest, 'PRESS ENTER');
      await click(guest, 'CUSTOMIZE');
      await guest.locator('.name-field').fill('GUEST');
      await click(guest, 'DONE');
      await visible(guest, '.screen.main-menu');
      await guest.goto(`${env.origin}/?e2e=1&join=${code}`, { timeout: STEP_MS });
      await guest.waitForFunction(() => window.__shotReady === true, null, { timeout: STEP_MS });
      await guest.locator('.screen.gate').click();
      await visible(guest, '.panel.lobby.join');
      deepStrictEqual(await guest.locator('.code-field').inputValue(), code, 'the invite link fills the code in');
      await click(guest, 'CONNECT');
      await joinLobby(guest);
      await visible(host, '.lobby.host .opponent');
      const hostSees = await host.locator('.lobby.host .opponent .name').textContent();
      const guestSees = await guest.locator('.lobby.join .opponent .name').textContent();
      deepStrictEqual([hostSees, guestSees], ['GUEST', 'PLAYER'], 'each lobby shows the other player');
      ok(!new URL(guest.url()).searchParams.has('join'), `joining leaves ?join= in the URL: ${guest.url()}`);
      await click(guest, 'READY');
      await host.locator('.lobby.host .opponent .state.on').waitFor({ timeout: STEP_MS });
      await shot(host, '5-online-host-lobby');
      await shot(guest, '5-online-guest-lobby');
      await click(host, 'READY');

      const [h, g] = await Promise.all([
        waitSnap(host, (s) => s.me !== null, 'the match on the host'),
        waitSnap(guest, (s) => s.me !== null, 'the match on the guest'),
      ]);
      deepStrictEqual([h.me, g.me], [0, 1]);
      // Two flawless typists on medium words can rally for most of a minute; the hardest words end points sooner.
      const typist = (page, side) =>
        play(page, (s) => s.points >= 2, {
          shotNames: { chase: `5-online-${side}-chase`, pointCall: `5-online-${side}-pointCall` },
          choose: hardestOption,
          timeout: ONLINE_MS,
          what: `2 points played on the ${side}'s page`,
        });
      await Promise.all([typist(host, 'host'), typist(guest, 'guest')]);
      await sleep(BANNER_MS);
      await shot(host, '5-online-host-2points');
      await shot(guest, '5-online-guest-2points');
    });
  });
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  log('vite build');
  await build({ root: ROOT, logLevel: 'warn' });
  const server = await preview({ root: ROOT, preview: { port: 0, open: false }, logLevel: 'warn' });
  let browser = null;
  try {
    const origin = `http://localhost:${server.httpServer.address().port}`;
    log(`vite preview: ${origin}`);
    browser = await launchChrome();
    const env = { browser, origin };
    const results = await runScenarios(
      [
        { name: '1 boot → gate → title', run: () => bootScenario(env) },
        { name: '2 every screen at 960×540 and 1920×1080', run: () => screensScenario(env) },
        { name: '3 Training lesson 1 by keyboard', run: () => trainingScenario(env) },
        { name: '4 vs-CPU tiebreak to Results', run: () => matchScenario(env) },
        { name: '5 online: host, join, 2 points', run: () => onlineScenario(env) },
      ],
      log,
    );
    log(`${shots.length} screenshots in artifacts/e2e/: ${shots.join(', ')}`);
    for (const line of summary(results)) {
      if (line.startsWith('WARN')) console.warn(`[e2e] ${line}`);
      else if (line.startsWith('FAIL')) console.error(`[e2e] ${line}`);
      else log(line);
    }
    return exitCode(results);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
