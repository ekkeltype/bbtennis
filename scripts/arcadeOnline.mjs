/**
 * `node scripts/arcadeOnline.mjs [--lag=<ms>] [--origin=<url>]` (online spec §7, in the browser): two
 * Chrome pages play an online Arcade match against each other over the real PeerJS broker, against the
 * Vite dev server (scripts/lib/pageShot.mjs) or, with `--origin`, a deployed site (for example
 * `--origin=https://ekkeltype.github.io/bbtennis`), both on `arcade/index.html?debug&lag=<ms>` (60 ms
 * by default: every message a page sends waits that long, ±25 %, so rollback is exercised on one
 * machine).
 *
 * The host opens PLAY ONLINE → HOST GAME and reads its game code; the guest names itself GUEST in
 * Customize, opens the invite link (`?join=CODE`) and connects; both press READY. Each page is played
 * by scripts/lib/arcadeBot.mjs from its own end (the guest as player 1, seeing its court turned
 * around). After a few points the run checks that neither page logged a desync and that both hashed
 * the same states at every checkpoint they share, and the score; then the host forfeits from the
 * menu (both Results say so), both ask for a rematch, play a point, and the guest forfeits and leaves
 * (the host's Results then say "OPPONENT LEFT" with Rematch disabled). Screenshots of both views go to
 * artifacts/arcade-online/ (cleared first).
 *
 * Exits 1 on a console error on either page, a desync, a mismatched hash or score, a timeout, or when
 * Chrome or the server can't start; 0 otherwise, also (with a SKIP line) when the broker can't be
 * reached. The browser and the server are always closed.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArcadeBot, TICK_HZ } from './lib/arcadeBot.mjs';
import { launchChrome, openReadyPage, startDevServer } from './lib/pageShot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'artifacts', 'arcade-online');
const VIEWPORT = { width: 960, height: 540 };
const LAG_MS = Number(process.argv.find((a) => a.startsWith('--lag='))?.slice(6) ?? 60);
/** A deployed site to play on instead of a dev server, without a trailing slash. */
const ORIGIN = process.argv.find((a) => a.startsWith('--origin='))?.slice(9).replace(/\/+$/, '') ?? null;
/** Longest wait for a page or a screen, and for the broker. */
const STEP_MS = 20_000;
const NET_MS = 30_000;
/** Points to play in the first match before the checks. */
const POINTS = 4;
/** Wall-clock cap for each stretch of play. */
const PLAY_WALL_MS = 4 * 60_000;
/** A page whose match time has not moved for this long has stalled. */
const STALL_MS = 10_000;
const POLL_MS = 8;
/** The host lobby's status when the broker cannot be reached (src/net/netErrors.ts errorText 'broker'). */
const BROKER_DOWN = "Can't reach the connection server";

const log = (line) => console.log(`[arcadeOnline] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shots = [];

class Skip extends Error {}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  shots.push(`${name}.png`);
}

const visible = (page, selector, timeout = STEP_MS) => page.locator(selector).first().waitFor({ state: 'visible', timeout });

/** Clicks the menu button labelled exactly `label` once it is visible and enabled. */
const click = (page, label) => page.locator('#ui button', { hasText: new RegExp(`^${label}$`) }).first().click({ timeout: STEP_MS });

const stateOf = (page) => page.evaluate(() => window.__arcade.state());
const netOf = (page) => page.evaluate(() => window.__arcade.net());
const titleOf = (page) => page.locator('#ui .panel-title').first().textContent();

function expect(ok, what) {
  if (!ok) throw new Error(what);
}

/** Waits for the host lobby's game code; null when the lobby could not reach the broker. */
async function hostCode(page) {
  await page.waitForFunction(
    () => {
      const code = document.querySelector('.lobby.host .code')?.textContent ?? '';
      const retry = [...document.querySelectorAll('.lobby.host button')].find((b) => b.textContent === 'RETRY');
      return /^[A-Z2-9]{5}$/.test(code) || retry?.hidden === false;
    },
    null,
    { timeout: NET_MS },
  );
  const lobby = page.locator('.panel.lobby.host');
  if (await lobby.locator('button', { hasText: /^RETRY$/ }).isHidden()) return lobby.locator('.code').textContent();
  const status = await lobby.locator('.status').textContent();
  if (status === BROKER_DOWN) return null;
  throw new Error(`the host lobby failed: ${status}`);
}

/** Waits until the guest is in the host's lobby. */
async function joinLobby(page) {
  await page.waitForFunction(
    () => {
      const name = document.querySelector('.lobby.join .opponent .name')?.textContent ?? '';
      const retry = [...document.querySelectorAll('.lobby.join button')].find((b) => b.textContent === 'RETRY');
      return name !== '' || retry?.hidden === false;
    },
    null,
    { timeout: NET_MS },
  );
  const lobby = page.locator('.panel.lobby.join');
  if (await lobby.locator('.opponent').isVisible()) return;
  const status = await lobby.locator('.status').textContent();
  if (status === BROKER_DOWN) throw new Skip(`the guest cannot reach the PeerJS broker ("${status}")`);
  throw new Error(`joining failed: ${status}`);
}

/**
 * Plays both pages with their bots until `done([hostState, guestState])`; screenshots `<side>-rally`
 * once each side has a rally going. Resolves to the last states.
 */
async function playBoth(pages, bots, done, tag) {
  const end = Date.now() + PLAY_WALL_MS;
  const states = [null, null];
  const sides = ['host', 'guest'];
  let finished = false;
  await Promise.all(
    pages.map(async (page, i) => {
      let lastTick = -1;
      let movedAt = Date.now();
      for (;;) {
        const s = await stateOf(page);
        states[i] = s;
        if (finished || (states[0] !== null && states[1] !== null && done(states))) {
          finished = true;
          return;
        }
        if (s.tick !== lastTick) {
          lastTick = s.tick;
          movedAt = Date.now();
        }
        if (Date.now() > end || Date.now() - movedAt > STALL_MS) {
          finished = true;
          const why = Date.now() > end ? `timed out after ${PLAY_WALL_MS} ms` : `the ${sides[i]} page stalled for ${STALL_MS} ms`;
          const nets = await Promise.all(pages.map(netOf));
          const at = states.map((x, k) => `${sides[k]} tick ${x?.tick} (${x?.phase.kind}), net ${JSON.stringify({ ...nets[k], sums: undefined })}`);
          throw new Error(`${tag}: ${why}; match time ${(s.tick / TICK_HZ).toFixed(1)} s\n${at.join('\n')}`);
        }
        const rally = `${sides[i]}-rally`;
        if (!shots.includes(`${rally}.png`) && s.point.hits >= 3 && s.flight !== null && s.tick - s.flight.hit.tick >= 15) await shot(page, rally);
        await bots[i].act(s);
        await sleep(POLL_MS);
      }
    }),
  );
  for (const b of bots) await b.hold([]);
  return states;
}

/** Reads both pages until they are at the same point and both are playing it; returns their states. */
async function samePoint(pages) {
  const end = Date.now() + STEP_MS;
  for (;;) {
    const [a, b] = await Promise.all(pages.map(stateOf));
    const playing = (s) => s.phase.kind === 'setup' || s.phase.kind === 'toss' || s.phase.kind === 'rally';
    if (a.pointNo === b.pointNo && playing(a) && playing(b)) return [a, b];
    if (Date.now() > end) throw new Error(`the pages never met at a point: host point ${a.pointNo}, guest point ${b.pointNo}`);
    await sleep(20);
  }
}

/** Both pages' netcode agrees: no desync, and the same hash at every checkpoint both sent (at least `min`). */
async function checkNet(pages, min, tag) {
  const [h, g] = await Promise.all(pages.map(netOf));
  expect(h !== null && g !== null, `${tag}: no online match on a page`);
  expect(h.desyncs === 0 && g.desyncs === 0, `${tag}: desyncs host ${h.desyncs}, guest ${g.desyncs}`);
  const common = Object.keys(h.sums).filter((t) => g.sums[t] !== undefined);
  const differ = common.filter((t) => h.sums[t] !== g.sums[t]);
  expect(differ.length === 0, `${tag}: hashes differ at ticks ${differ.join(', ')}`);
  expect(common.length >= min, `${tag}: only ${common.length} shared checkpoints`);
  log(
    `${tag}: ${common.length} checkpoints agree; host tick ${h.tick} (rollbacks ${h.rollbacks}, deepest ${h.maxDepth}, stalls ${h.stalls}), ` +
      `guest tick ${g.tick} (rollbacks ${g.rollbacks}, deepest ${g.maxDepth}, stalls ${g.stalls}); RTT ${Math.round(h.rttMs ?? -1)} ms`,
  );
}

async function run(browser, origin) {
  const url = (extra = '') => `${origin}/arcade/index.html?debug&lag=${LAG_MS}${extra}`;
  const hostTab = await openReadyPage(browser, url(), { viewport: VIEWPORT, timeout: STEP_MS, tag: 'host' });
  const host = hostTab.page;
  let guestTab = null;
  try {
    await host.locator('.screen.gate').click();
    await click(host, 'PRESS ENTER');
    await click(host, 'PLAY ONLINE');
    await click(host, 'HOST GAME');
    await visible(host, '.panel.lobby.host');
    const code = await hostCode(host);
    if (code === null) throw new Skip(`the host cannot reach the PeerJS broker ("${BROKER_DOWN}")`);
    log(`game code ${code}; ${LAG_MS} ms added each way`);

    guestTab = await openReadyPage(browser, url(), { viewport: VIEWPORT, timeout: STEP_MS, tag: 'guest' });
    const guest = guestTab.page;
    await guest.locator('.screen.gate').click();
    await click(guest, 'PRESS ENTER');
    await click(guest, 'CUSTOMIZE');
    await guest.locator('.name-field').fill('GUEST');
    await click(guest, 'DONE');
    await visible(guest, '.screen.main-menu');
    await guest.goto(url(`&join=${code}`), { timeout: STEP_MS });
    await guest.waitForFunction(() => window.__shotReady === true, null, { timeout: STEP_MS });
    await guest.locator('.screen.gate').click();
    await visible(guest, '.panel.lobby.join');
    expect((await guest.locator('.code-field').inputValue()) === code, 'the invite link fills the code in');
    await click(guest, 'CONNECT');
    await joinLobby(guest);
    await visible(host, '.lobby.host .opponent');
    const seen = [await host.locator('.lobby.host .opponent .name').textContent(), await guest.locator('.lobby.join .opponent .name').textContent()];
    expect(seen[0] === 'GUEST' && seen[1] === 'PLAYER', `each lobby shows the other player: ${seen.join(' / ')}`);
    expect(!new URL(guest.url()).searchParams.has('join'), `joining leaves ?join= in the URL: ${guest.url()}`);
    await click(guest, 'READY');
    await host.locator('.lobby.host .opponent .state.on').waitFor({ timeout: STEP_MS });
    await shot(host, 'host-lobby');
    await shot(guest, 'guest-lobby');
    await click(host, 'READY');

    const pages = [host, guest];
    await Promise.all(pages.map((p) => visible(p, '.screen.play')));
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.__arcade.state() !== null, null, { timeout: STEP_MS })));
    const first = await stateOf(host);
    expect(first.players[0].name === 'PLAYER' && first.players[1].name === 'GUEST', `players ${first.players.map((p) => p.name).join(' v ')}`);
    await sleep(1500);
    await shot(host, 'host-intro');
    await shot(guest, 'guest-intro');

    const bots = [new ArcadeBot(host, 0), new ArcadeBot(guest, 1)];
    await playBoth(pages, bots, ([a, b]) => a.pointNo >= POINTS && b.pointNo >= POINTS, 'match 1');
    const [a, b] = await samePoint(pages);
    expect(JSON.stringify(a.score) === JSON.stringify(b.score), `the scores differ: ${JSON.stringify(a.score)} / ${JSON.stringify(b.score)}`);
    const hits = a.stats[0].hits + a.stats[1].hits;
    log(`after ${a.pointNo} points: ${a.stats[0].pointsWon}–${a.stats[1].pointsWon}, ${hits} returns, longest rally ${a.longestRally}`);
    await checkNet(pages, 5, 'match 1');

    // The host forfeits from the menu: both Results say so.
    await host.keyboard.press('Escape');
    await visible(host, '.pause-panel');
    expect((await titleOf(host)) === 'MENU', 'the online menu is MENU');
    await shot(host, 'host-menu');
    await click(host, 'FORFEIT');
    await Promise.all(pages.map((p) => visible(p, '.panel.results')));
    const titles = [await titleOf(host), await titleOf(guest)];
    expect(titles[0] === 'PLAYER FORFEITS' && titles[1] === 'PLAYER FORFEITS', `forfeit Results: ${titles.join(' / ')}`);
    await shot(host, 'host-results-forfeit');
    await shot(guest, 'guest-results-forfeit');

    // Rematch: both ask; the host starts match 2.
    await click(guest, 'REMATCH');
    await guest.locator('#ui button', { hasText: /^WAITING FOR OPPONENT\.\.\.$/ }).waitFor({ timeout: STEP_MS });
    await click(host, 'REMATCH');
    await Promise.all(pages.map((p) => visible(p, '.screen.play')));
    await playBoth(pages, bots.map((bot, i) => new ArcadeBot(pages[i], bot.me)), ([s, t]) => s.pointNo >= 1 && t.pointNo >= 1, 'match 2');
    await samePoint(pages);
    await checkNet(pages, 1, 'match 2');

    // The guest forfeits and leaves: the host's Results say the opponent left, Rematch off.
    await guest.keyboard.press('Escape');
    await visible(guest, '.pause-panel');
    await click(guest, 'FORFEIT');
    await Promise.all(pages.map((p) => visible(p, '.panel.results')));
    await click(guest, 'MENU');
    await visible(guest, '.screen.main-menu');
    await host.locator('#ui .opponent-gone', { hasText: 'OPPONENT LEFT' }).waitFor({ timeout: STEP_MS });
    expect(await host.locator('#ui button', { hasText: /^REMATCH$/ }).isDisabled(), 'Rematch is disabled once the opponent left');
    await shot(host, 'host-results-left');

    for (const tab of [hostTab, guestTab]) {
      if (tab.errorCount === 0) continue;
      const errors = tab.transcript.filter((l) => l.startsWith('[console.error]') || l.startsWith('[pageerror]'));
      throw new Error(`a page logged ${tab.errorCount} error(s):\n${errors.join('\n')}`);
    }
    const warnings = [hostTab, guestTab].flatMap((t) => t.transcript.filter((l) => l.includes('[bbt]')));
    expect(warnings.length === 0, `[bbt] warnings:\n${warnings.join('\n')}`);
  } finally {
    await guestTab?.page.context().close();
    await host.context().close();
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const { server, origin } = ORIGIN === null ? await startDevServer(ROOT) : { server: null, origin: ORIGIN };
  let browser = null;
  try {
    log(ORIGIN === null ? `vite dev server: ${origin}` : `site: ${origin}`);
    browser = await launchChrome();
    await run(browser, origin);
    log('PASS');
    return 0;
  } catch (err) {
    if (!(err instanceof Skip)) throw err;
    log(`SKIP: ${err.message}`);
    return 0;
  } finally {
    log(`${shots.length} screenshots in artifacts/arcade-online/: ${shots.join(', ') || '(none)'}`);
    await browser?.close();
    await server?.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[arcadeOnline] FAIL: ${err.message ?? err}`);
    process.exitCode = 1;
  },
);
