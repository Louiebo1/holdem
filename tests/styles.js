// How each bot style plays, in the same numbers the Statistics screen shows a person
// (handstats.js), for STYLE_PROFILES there.
//   jsc tests/args.js -m tests/styles.js -- TOURNAMENTS PLAYERS SEED
import { seeded } from '../js/cards.js';
import * as G from '../js/game.js';
import { Bot, STYLE_NAMES, settings } from '../js/bot.js';
import { blankLine, recordHand, styleNumbers } from '../js/handstats.js';

const [count = 50, players = 6, seed = 1] = (globalThis.scriptArgs || []).map(Number);
settings.trials = 250;
const rng = seeded(seed);
const lines = Object.fromEntries(STYLE_NAMES.map((s) => [s, blankLine()]));
for (let t = 0; t < count; t++) {
  const styles = Array.from({ length: players }, () => STYLE_NAMES[rng.below(STYLE_NAMES.length)]);
  const bots = styles.map((style) => new Bot({ style }));
  const g = G.newGame(players, rng);
  while (g.phase !== 'gameOver') {
    if (g.phase === 'handOver') { G.nextHand(g, rng); continue; }
    G.apply(g, bots[g.turn].move(g, g.turn, rng), g.turn);
    if (g.result) styles.forEach((s, i) => recordHand(lines[s], g, i, 0, rng));
  }
}
// Raw counts, so several runs can be added up.
print(JSON.stringify(Object.fromEntries(STYLE_NAMES.map((s) => [s, lines[s].style]))));
for (const s of STYLE_NAMES) {
  const n = styleNumbers(lines[s]);
  print(`${s.padEnd(8)} hands ${lines[s].style.dealt}  vpip ${n.vpip.toFixed(3)}  pfr ${n.pfr.toFixed(3)}  agg ${n.aggression.toFixed(2)}  wtsd ${n.wtsd.toFixed(3)}  wsd ${n.wsd.toFixed(3)}`);
}
