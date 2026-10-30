// The bots think in a background worker (js/worker.js), so the table never stalls while
// they look ahead. Where workers aren't available (or fail) they think right here.

import { Bot } from './bot.js';
import { coach } from './coach.js';

// ?noworker (testing in headless Chrome, whose virtual clock doesn't wait for workers).
let worker = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noworker') ? false : null;      // null: not started yet; false: not available.
const pending = new Map();
let nextId = 0;

const here = (game, seat, style, names) => (names ? coach(game, seat, (s) => names[s]) : new Bot({ style }).move(game, seat));

function start() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (job) job.resolve(e.data.error ? here(job.game, job.seat, job.style, job.names) : job.names ? e.data.coach : e.data.move);
    };
    worker.onerror = () => {
      // Think here instead, from now on, including anything already asked.
      worker = false;
      for (const [id, job] of pending) { pending.delete(id); job.resolve(here(job.game, job.seat, job.style, job.names)); }
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

/** Learn mode: everything the coach has to say to `seat` right now (names: what to call each seat). */
export function coachFor(game, seat, names) {
  if (typeof Worker === 'undefined' || !start()) return Promise.resolve(here(game, seat, null, names));
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, { resolve, game, seat, names });
    worker.postMessage({ id, game, seat, kind: 'coach', names });
  });
}
