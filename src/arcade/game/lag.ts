import type { Scheduler } from '../../game/clock';
import type { Transport } from '../../net/channel';

/** Jitter around the added delay: each message waits ms × (1 ± JITTER). */
const JITTER = 0.25;

/**
 * `inner` with every message this side sends held back `ms` (± 25 %) first, and the close after the
 * last of them (online spec §1.2: `?debug&lag=<ms>` tries rollback on one machine). What arrives is
 * untouched. The messages wait in one queue behind one timer, so they leave in send order: browsers
 * round timer delays, and two timers due a fraction of a millisecond apart can fire the wrong way round.
 */
export function laggy<M>(inner: Transport<M>, ms: number, s: Scheduler, rand: () => number = Math.random): Transport<M> {
  const queue: { due: number; m: M | 'close' }[] = [];
  let lastDue = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | null = null;
  /** Sends everything due by now, in order, then waits for the next one. */
  const flush = (): void => {
    cancel = null;
    const now = s.now();
    while (queue.length > 0 && queue[0]!.due <= now) {
      const { m } = queue.shift()!;
      if (m === 'close') inner.close();
      else inner.send(m);
    }
    if (queue.length > 0) cancel = s.after(queue[0]!.due - now, flush);
  };
  const push = (m: M | 'close', delay: number): void => {
    lastDue = Math.max(s.now() + delay, lastDue);
    queue.push({ due: lastDue, m });
    if (cancel === null) cancel = s.after(lastDue - s.now(), flush);
  };
  return {
    send(m) {
      push(m, ms * (1 - JITTER + 2 * JITTER * rand()));
    },
    onMessage(cb) {
      inner.onMessage(cb);
    },
    onClose(cb) {
      inner.onClose(cb);
    },
    close() {
      push('close', 0);
    },
    get bufferedAmount() {
      return inner.bufferedAmount;
    },
  };
}
