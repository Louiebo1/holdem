// The bots think in a background worker (js/worker.js), so the table never stalls while
// they look ahead. Where workers aren't available (or fail) they think right here.

import { Bot } from './bot.js';

// ?noworker (testing in headless Chrome, whose virtual clock doesn't wait for workers).
let worker = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noworker') ? false : null;      // null: not started yet; false: not available.
const pending = new Map();
let nextId = 0;

const here = (game, seat, style) => new Bot({ style }).move(game, seat);

function start() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (job) job.resolve(e.data.error ? here(job.game, job.seat, job.style) : e.data.move);
    };
    worker.onerror = () => {
      // Think here instead, from now on, including anything already asked.
      worker = false;
      for (const [id, job] of pending) { pending.delete(id); job.resolve(here(job.game, job.seat, job.style)); }
    };
  } catch {
    worker = false;
  }
  return worker;
}

/** What the bot with `style` playing `seat` does now. */
export function think(game, seat, style = 'grinder') {
  if (typeof Worker === 'undefined' || !start()) return Promise.resolve(here(game, seat, style));
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, { resolve, game, seat, style });
    worker.postMessage({ id, game, seat, style });
  });
}
