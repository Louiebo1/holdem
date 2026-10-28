// Table sounds, synthesized in code with the app's formulas (no sound files): a card
// snap, the deal, a knock on the table (a check), chips into the pot, and a fanfare when you win.

const RATE = 44100;
let ctx = null;
const buffers = {};
export const sound = { on: true };

/** Repeatable white noise, so each sound is the same every time. */
function noise(seed) {
  let state = BigInt(seed);
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
    return Number(state >> 11n) / 2 ** 53 * 2 - 1;
  };
}

const silence = (seconds) => new Float32Array(Math.floor(seconds * RATE));

function snap(seed = 7, volume = 0.5, length = 0.07) {
  const next = noise(seed), out = silence(length);
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE, n = next();
    const bright = n - last; last = n;                       // High-pass: the papery click.
    const click = bright * Math.exp(-t / 0.008);
    const thump = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t / 0.015) * 0.6;
    out[i] = volume * (click * 0.7 + thump) * Math.min(1, t / 0.0005);
  }
  return out;
}

function deal() {
  const out = silence(12 * 0.045 + 0.1);
  for (let c = 0; c < 12; c++) {
    const flick = snap(c + 11, c % 3 === 1 ? 0.3 : 0.36, 0.04);
    const start = Math.floor((c * 0.045 + (c % 2 === 0 ? 0 : 0.006)) * RATE);
    for (let i = 0; i < flick.length && start + i < out.length; i++) out[start + i] += flick[i];
  }
  return out;
}

/** A knock on the table: two hollow raps. */
function knock() {
  const next = noise(21), out = silence(0.36);
  for (const hit of [0, 0.14]) {
    const start = Math.floor(hit * RATE);
    for (let i = 0; i < Math.floor(0.16 * RATE) && start + i < out.length; i++) {
      const t = i / RATE;
      const body = Math.sin(2 * Math.PI * 190 * t) * 0.9 + Math.sin(2 * Math.PI * 410 * t) * 0.45 + Math.sin(2 * Math.PI * 960 * t) * 0.2;
      const tap = next() * Math.exp(-t / 0.002);
      out[start + i] += 0.6 * (body * Math.exp(-t / 0.04) + 0.5 * tap) * Math.min(1, t / 0.0006);
    }
  }
  return out;
}

function fanfare() {
  const notes = [[0, 0.16, [523.25]], [0.13, 0.16, [659.25]], [0.26, 0.16, [783.99]], [0.39, 0.22, [1046.5]],
    [0.58, 1.1, [523.25, 659.25, 783.99, 1046.5]]];
  const out = silence(1.75);
  for (const [start, length, freqs] of notes) {
    const first = Math.floor(start * RATE);
    for (let n = 0; n < Math.floor(length * RATE) && first + n < out.length; n++) {
      const t = n / RATE;
      const envelope = Math.min(1, t / 0.01) * Math.exp(-3.2 * t / length);
      let v = 0;
      for (const fr of freqs) v += Math.sin(2 * Math.PI * fr * t) + 0.35 * Math.sin(4 * Math.PI * fr * t) + 0.12 * Math.sin(6 * Math.PI * fr * t);
      out[first + n] += 0.22 * envelope * v / Math.sqrt(freqs.length);
    }
  }
  return out;
}

/** Clay chips dropped on a stack: four quick, bright clacks (the app's). */
function chips() {
  const next = noise(33), out = silence(0.26);
  [0, 0.045, 0.08, 0.125].forEach((hit, k) => {
    const start = Math.floor(hit * RATE), pitch = [3100, 3500, 2900, 3300][k];
    for (let i = 0; i < Math.floor(0.06 * RATE) && start + i < out.length; i++) {
      const t = i / RATE;
      const ring = Math.sin(2 * Math.PI * pitch * t) * 0.6 + Math.sin(2 * Math.PI * pitch * 1.52 * t) * 0.3;
      const click = next() * Math.exp(-t / 0.0015);
      out[start + i] += (k === 0 ? 0.42 : 0.3) * (ring * Math.exp(-t / 0.012) + 0.7 * click);
    }
  });
  return out;
}

const MAKERS = { snap: () => snap(), deal, knock, fanfare, chips };

/** Browsers only allow sound after a tap: call this from one. */
export function unlockSound() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}

export function play(name, delay = 0) {
  if (!sound.on || !ctx || ctx.state !== 'running') return;
  if (!buffers[name]) {
    const samples = MAKERS[name]();
    const buffer = ctx.createBuffer(1, samples.length, RATE);
    buffer.getChannelData(0).set(samples.map((v) => Math.max(-0.95, Math.min(0.95, v))));
    buffers[name] = buffer;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffers[name];
  source.connect(ctx.destination);
  source.start(ctx.currentTime + delay / 1000);
}
