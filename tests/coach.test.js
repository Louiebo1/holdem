// Learn mode's coach over many random hands: no crashes, sensible numbers. Run with:
// jsc -m tests/coach.test.js
import { seeded, card, CLUBS, DIAMONDS, HEARTS, SPADES } from '../js/cards.js';
import * as G from '../js/game.js';
import { Bot, settings } from '../js/bot.js';
import { coach, review, describeMade, countOuts, moveText, seatPosition } from '../js/coach.js';

let failures = 0, checks = 0;
const check = (ok, what) => { checks++; if (!ok) { failures++; print('FAIL: ' + what); } };
function cards(text) {
  return text.split(' ').map((t) => card({ c: CLUBS, d: DIAMONDS, h: HEARTS, s: SPADES }[t.slice(-1)], { A: 14, K: 13, Q: 12, J: 11, T: 10 }[t.slice(0, -1)] || Number(t.slice(0, -1))));
}
check(describeMade(cards('Ah Kd'), cards('Ks 7c 2d')).title.startsWith('Top pair, top kicker'), 'top pair');
check(describeMade(cards('Qh Qd'), cards('Js 7c 2d')).title.startsWith('Overpair'), 'overpair');
check(describeMade(cards('7h 7d'), cards('7s Kc 2d')).title.startsWith('A set'), 'set');
check(describeMade(cards('Ah 5h'), cards('Kh 9h 2h')).text.includes('nut flush'), 'nut flush');
const o = countOuts(cards('Ah 5h'), cards('Kh 9h 2c'));
check(o.groups[5] === 9, 'nine flush outs: ' + JSON.stringify(o.groups));
const o2 = countOuts(cards('9c 8d'), cards('7h 6s 2c'));
check(o2.groups[4] === 8, 'open-ended: ' + JSON.stringify(o2.groups));

settings.trials = 150;
const rng = seeded(7);
const showOne = (c) => { for (const s of c.sections) { print('## ' + s.title); s.lines.forEach((l) => print('  ' + l)); } if (c.advice) { print('>> ' + c.advice.title); c.advice.lines.forEach((l) => print('   ' + l)); } };
let shown = 0, turns = 0, reviews = 0;
for (let t = 0; t < 12; t++) {
  const g = G.newGame(t % 2 ? 9 : 6, rng);
  const bots = g.seats.map(() => new Bot({ style: 'grinder' }));
  let decisions = [], guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 4000) {
    if (g.phase === 'handOver') {
      if (g.seats[0].inHand || decisions.length) {
        const r = review(g, 0, decisions);
        check(Array.isArray(r) && r.length > 0, 'review lines');
        reviews++;
        if (reviews === 3 || reviews === 40) r.forEach((l) => print('  R: ' + l));
      }
      decisions = [];
      G.nextHand(g, rng);
      continue;
    }
    const seat = g.turn;
    if (seat === 0 || (!g.seats[0].folded && g.seats[0].inHand && rng.unit() < 0.15)) {
      const c = coach(g, 0, undefined, rng);
      if (c) {
        check(c.sections.every((s) => s.lines.every((l) => typeof l === 'string' && !l.includes('undefined') && !l.includes('NaN'))), 'clean text: ' + JSON.stringify(c.sections));
        if (seat === 0) {
          turns++;
          check(!!c.advice && !!c.advice.title && !c.advice.lines.some((l) => l.includes('undefined') || l.includes('NaN')), 'advice: ' + JSON.stringify(c.advice));
          if ((turns === 5 || turns === 61 || turns === 140) && shown < 3) { shown++; print('---- hand ' + g.handNumber + ' street ' + g.street); showOne(c); }
          const m = rng.unit() < 0.7 ? c.numbers.advice : bots[0].move(g, 0, rng);
          decisions.push({ street: g.street, move: m, text: moveText(m, g, 0), adviceText: moveText(c.numbers.advice, g, 0), numbers: c.numbers });
          G.apply(g, m, 0);
          continue;
        }
      }
    }
    if (g.turn === seat) G.apply(g, bots[seat].move(g, seat, rng), seat);
  }
}
print(`${turns} coached turns, ${reviews} reviews`);
print(failures ? `${failures} of ${checks} checks FAILED` : `All ${checks} checks passed`);
