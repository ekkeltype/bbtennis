/**
 * Page-shot harness shared by scripts/devshot.mjs and scripts/artExport.mjs: a Vite dev server on a
 * free port, the local Chrome via playwright-core, and a page opened with its console recorded until
 * it signals `window.__shotReady === true`.
 */
import { chromium, errors } from 'playwright-core';
import { createServer } from 'vite';

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** A page step timed out. The message is the summary followed by the page's console transcript. */
export class PageTimeoutError extends Error {
  /** `summary` says what timed out; `transcript` is copied, so later console lines do not change it. */
  constructor(summary, transcript) {
    super(`${summary}\n${transcript.length > 0 ? transcript.join('\n') : '(no page console output)'}`);
    this.name = 'PageTimeoutError';
    /** The page's console and page-error lines up to the timeout. */
    this.transcript = [...transcript];
  }
}

/** Launches Chrome via the 'chrome' channel, then via CHROME_PATH; if both fail, throws with both errors. */
export async function launchChrome() {
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

/** Starts a multi-page Vite dev server (a missing page is a 404) over `root` on a free port. */
export async function startDevServer(root) {
  const server = await createServer({
    root,
    appType: 'mpa',
    server: { port: 0, forwardConsole: false },
    logLevel: 'warn',
    clearScreen: false,
  });
  try {
    await server.listen();
  } catch (err) {
    await server.close();
    throw err;
  }
  const { port } = server.httpServer.address();
  return { server, origin: `http://localhost:${port}` };
}

/** Returns the Playwright `step`'s result; a Playwright timeout becomes PageTimeoutError(summary, transcript). */
export async function withTimeoutTranscript(step, summary, transcript) {
  try {
    return await step();
  } catch (err) {
    if (err instanceof errors.TimeoutError) throw new PageTimeoutError(summary, transcript);
    throw err;
  }
}

/**
 * Opens `url` in a new `viewport`-sized context at device scale 1 and waits, up to `timeout` ms per
 * step, for `window.__shotReady === true`. Resolves to `{ page, transcript, errorCount }`: every
 * console message and page error goes into the live `transcript` array; errors are also echoed to
 * stderr as `<tag>: <line>` and counted by the live `errorCount` getter, which keeps counting after
 * the page is ready. Throws PageTimeoutError when loading or the ready wait times out, and an Error on
 * a non-ok HTTP status; the context is closed on failure.
 */
export async function openReadyPage(browser, url, { viewport, timeout, tag }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  try {
    await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    const page = await context.newPage();
    const transcript = [];
    let errorCount = 0;
    const record = (line, isError) => {
      transcript.push(line);
      if (!isError) return;
      errorCount++;
      console.error(`${tag}: ${line}`);
    };
    page.on('console', (msg) => record(`[console.${msg.type()}] ${msg.text()}`, msg.type() === 'error'));
    page.on('pageerror', (err) => record(`[pageerror] ${err.stack ?? err.message}`, true));

    const response = await withTimeoutTranscript(
      () => page.goto(url, { timeout }),
      `timed out after ${timeout} ms loading ${url}`,
      transcript,
    );
    if (response && !response.ok()) throw new Error(`HTTP ${response.status()} for ${url}`);
    await withTimeoutTranscript(
      () => page.waitForFunction(() => window.__shotReady === true, null, { timeout }),
      `timed out after ${timeout} ms waiting for window.__shotReady on ${url}`,
      transcript,
    );
    return {
      page,
      transcript,
      get errorCount() {
        return errorCount;
      },
    };
  } catch (err) {
    await context.close();
    throw err;
  }
}
