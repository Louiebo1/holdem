// Bot-only tournaments, random styles: win rates by style (compare with the app's ./bench.sh).
//   jsc tests/args.js -m tests/bench.js -- TOURNAMENTS PLAYERS SEED
import { seeded } from '../js/cards.js';
import * as G from '../js/game.js';
import { Bot, STYLE_NAMES, settings } from '../js/bot.js';

const [count = 100, players = 6, seed = 1] = (globalThis.scriptArgs || []).map(Number);
settings.trials = 250;
const rng = seeded(seed);
const seats = {}, wins = {};
const start = Date.now();
let decisions = 0, hands = 0;
for (let t = 0; t < count; t++) {
  const styles = Array.from({ length: players }, () => STYLE_NAMES[rng.below(STYLE_NAMES.length)]);
  const bots = styles.map((style) => new Bot({ style }));
  const g = G.newGame(players, rng);
  while (g.phase !== 'gameOver') {
    if (g.phase === 'handOver') { G.nextHand(g, rng); continue; }
    G.apply(g, bots[g.turn].move(g, g.turn, rng), g.turn);
    decisions++;
  }
  hands += g.handNumber;
  styles.forEach((s, i) => { seats[s] = (seats[s] || 0) + 1; if (G.place(g, i) === 1) wins[s] = (wins[s] || 0) + 1; });
}
const ms = Date.now() - start;
print(`${count} tournaments, ${players} players, ${Math.round(hands / count)} hands each, ${(ms / decisions).toFixed(1)} ms a decision (fair ${(100 / players).toFixed(1)}%)`);
for (const s of STYLE_NAMES) print(`${s.padEnd(8)} ${String(seats[s]).padStart(4)} seats  ${(100 * (wins[s] || 0) / seats[s]).toFixed(1)}%`);
