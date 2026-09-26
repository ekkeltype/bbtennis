/** Longest frame time (ms) handed to `onFrame`: after a stall, animations resume instead of jumping. */
export const MAX_FRAME_DT_MS = 100;

/**
 * Calls `onFrame(dtMs)` once per animation frame, `dtMs` being the time since the previous frame (0 for
 * the first, capped at MAX_FRAME_DT_MS). The next frame is requested before `onFrame` runs, so a
 * throwing frame does not stop the loop. Returns stop().
 */
export function startLoop(onFrame: (dtMs: number) => void): () => void {
  let last: number | null = null;
  let id = 0;
  let stopped = false;
  const step = (t: number): void => {
    if (stopped) return;
    const dt = last === null ? 0 : Math.min(MAX_FRAME_DT_MS, Math.max(0, t - last));
    last = t;
    id = requestAnimationFrame(step);
    onFrame(dt);
  };
  id = requestAnimationFrame(step);
  return () => {
    stopped = true;
    cancelAnimationFrame(id);
  };
}

/**
 * Calls `fn` every `ms` from a Worker made from a Blob URL (spec §5.2), which browsers do not throttle
 * in hidden tabs the way they throttle the page's own timers. Falls back to setInterval when a worker
 * cannot be created or fails to load. Returns stop(). Throws RangeError unless `ms` is finite and > 0.
 */
export function workerTicker(ms: number, fn: () => void): () => void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`workerTicker: period must be a finite number > 0, got ${ms}`);
  let stopped = false;
  let cleanup = (): void => {};
  const fallback = (): void => {
    const id = setInterval(fn, ms);
    cleanup = () => clearInterval(id);
  };
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const blobUrl = url;
    cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    };
    worker.onmessage = () => fn();
    worker.onerror = () => {
      if (stopped) return;
      cleanup();
      fallback();
    };
  } catch {
    if (url !== null) URL.revokeObjectURL(url);
    fallback();
  }
  return () => {
    stopped = true;
    cleanup();
  };
}
