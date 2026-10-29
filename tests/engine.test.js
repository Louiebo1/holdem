// The rules and bots, checked like the app's EngineTests. Run with:
// /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/engine.test.js
import { card, seeded, CLUBS, DIAMONDS, HEARTS, SPADES } from '../js/cards.js';
import { evaluate, handName, category } from '../js/evaluator.js';
import { ORDER, COMBOS, percentile } from '../js/preflop.js';
import * as G from '../js/game.js';
import { Bot, STYLE_NAMES, settings } from '../js/bot.js';
import { newTableState, applyMove, nextHostStep } from '../js/table.js';
import { blankLine, normalize, recordHand, recordFinish, recordRivals, allInEquity, styleNumbers, closestStyle } from '../js/handstats.js';

let failures = 0, checks = 0;
function check(ok, what) {
  checks++;
  if (!ok) { failures++; print('FAIL: ' + what); }
}
const eq = (a, b, what) => check(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

/** "As Kd 7h" → cards. */
function cards(text) {
  return text.split(' ').map((t) => {
    const suit = { c: CLUBS, d: DIAMONDS, h: HEARTS, s: SPADES }[t.slice(-1)];
    const r = t.slice(0, -1);
    return card(suit, { A: 14, K: 13, Q: 12, J: 11, T: 10 }[r] || Number(r));
  });
}
const score = (t) => evaluate(cards(t));

// Evaluator
{
  const hands = ['2c 5d 9h Jc Ks 3d 7h', '2c 2d 9h Jc Ks 3d 7h', '2c 2d 9h 9c Ks 3d 7h', '2c 2d 2h Jc Ks 3d 7h', '4c 5d 6h 7c 8s Kd Kh',
    '2h 5h 9h Jh Ks 3d 7h', '2c 2d 2h Jc Js 3d 7h', '2c 2d 2h 2s Ks 3d 7h', '4h 5h 6h 7h 8h Kd Kc'];
  const scores = hands.map(score);
  scores.forEach((s, i) => eq(category(s), i, `category of ${hands[i]}`));
  check(scores.every((s, i) => i === 0 || s > scores[i - 1]), 'categories in order');
  eq(handName(score('Ac 2d 3h 4c 5s Kd 9h')), 'Straight, Five High', 'wheel');
  check(score('Ac 2d 3h 4c 5s Kd 9h') < score('2d 3h 4c 5s 6c Kd 9h'), 'wheel is lowest straight');
  check(score('Ac Ad Kh 7c 5s 3d 2h') > score('Ac Ad Qh 7c 5s 3d 2h'), 'kicker');
  eq(score('2c 3d Ah Ac Ks Kd Qh'), score('2h 4d Ah Ac Ks Kd Qh'), 'board plays');
  eq(score('Ac Ad Kh Kc 5s 5d Qh'), score('Ac Ad Kh Kc 2s 2d Qh'), 'three pairs');
  eq(handName(score('9c 9d 9h 4c 4s 4d 2h')), 'Full House, Nines Full of Fours', 'two trips');
  eq(handName(score('Ah Kh Qh Jh Th 2c 3d')), 'Royal Flush', 'royal');
  eq(ORDER.length, 169, '169 starting hands');
  eq(COMBOS.length, 1326, '1326 combos');
  check(percentile(cards('Ah')[0], cards('Kh')[0]) < percentile(cards('Ah')[0], cards('Kd')[0]), 'suited beats offsuit');
}

const game = (players, seed = 1) => G.newGame(players, seeded(seed));

// Blinds and first to act
{
  const g = game(6);
  eq(g.smallBlindSeat, (g.button + 1) % 6, 'small blind left of button');
  eq(g.bigBlindSeat, (g.button + 2) % 6, 'big blind');
  eq(g.turn, (g.button + 3) % 6, 'first to act');
  eq(G.pot(g), 30, 'blinds in the pot');
}
// Heads-up
{
  const g = game(2);
  eq(g.smallBlindSeat, g.button, 'heads-up button is small blind');
  eq(g.turn, g.button, 'heads-up button acts first');
  G.apply(g, { type: 'call' }, g.button);
  eq(g.turn, g.bigBlindSeat, 'big blind option');
  G.apply(g, { type: 'check' }, g.bigBlindSeat);
  eq(g.street, G.FLOP, 'flop');
  eq(g.turn, g.bigBlindSeat, 'big blind first after the flop');
}
// Everyone folds
{
  const g = game(4);
  const bb = g.bigBlindSeat, start = g.seats[bb].chips + g.seats[bb].bet;
  while (g.phase === 'betting') G.apply(g, { type: 'fold' }, g.turn);
  eq(g.result.won[bb], 30, 'big blind takes the blinds');
  eq(g.seats[bb].chips, start + 10, 'big blind chips');
}
// Minimum raise
{
  const g = game(4);
  const first = g.turn;
  eq(G.minRaiseTo(g, first), 40, 'min raise 40');
  check(!G.canApply(g, { type: 'raise', to: 30 }, first), 'no raise to 30');
  G.apply(g, { type: 'raise', to: 70 }, first);
  eq(G.minRaiseTo(g, g.turn), 120, 'next min raise 120');
}
// Short all-in doesn't reopen betting
{
  const g = game(3);
  const button = g.button, sb = g.smallBlindSeat, bb = g.bigBlindSeat;
  G.rig(g, [], [], g.seats.map((_, i) => (i === sb ? 50 : 1000)));
  G.apply(g, { type: 'raise', to: 50 }, button);
  G.apply(g, { type: 'raise', to: 60 }, sb);
  G.apply(g, { type: 'call' }, bb);
  eq(g.turn, button, 'back to the button');
  check(!G.canRaise(g, button), 'button may not raise again');
  check(G.canApply(g, { type: 'call' }, button), 'button may call');
}
// Side pots
{
  const g = game(3);
  const button = g.button, sb = g.smallBlindSeat, bb = g.bigBlindSeat;
  const holes = [[], [], []];
  holes[button] = cards('As Ad'); holes[sb] = cards('Ks Kd'); holes[bb] = cards('2c 7d');
  G.rig(g, holes, cards('3h 8s 9c Jd 4h'), g.seats.map((_, i) => ({ [button]: 100, [sb]: 300, [bb]: 1000 }[i])));
  G.apply(g, { type: 'raise', to: 100 }, button);
  G.apply(g, { type: 'raise', to: 310 }, sb);
  G.apply(g, { type: 'call' }, bb);
  const r = g.result;
  eq(r.pots.length, 2, 'two pots');
  eq([r.pots[0].amount, r.pots[0].winners], [300, [button]], 'main pot');
  eq([r.pots[1].amount, r.pots[1].winners], [420, [sb]], 'side pot');
  eq([g.seats[button].chips, g.seats[sb].chips], [300, 420], 'chips after');
  eq(g.runoutFrom, 0, 'board ran out from the start');
}
// Split pot
{
  const g = game(2);
  const a = g.button, b = g.bigBlindSeat;
  const holes = [[], []];
  holes[a] = cards('2c 3d'); holes[b] = cards('2h 3s');
  G.rig(g, holes, cards('Ah Kh Qd Jc Ts'));
  G.apply(g, { type: 'call' }, a);
  G.apply(g, { type: 'check' }, b);
  for (let i = 0; i < 6; i++) G.apply(g, { type: 'check' }, g.turn);
  eq(g.result.pots[0].winners.length, 2, 'split');
  eq([g.seats[a].chips, g.seats[b].chips], [1500, 1500], 'split chips');
}
// All in, knocked out
{
  const g = game(2);
  const a = g.button, b = g.bigBlindSeat;
  const holes = [[], []];
  holes[a] = cards('As Ad'); holes[b] = cards('7c 2d');
  G.rig(g, holes, cards('3h 8s 9c Jd 4h'));
  G.apply(g, { type: 'raise', to: 1500 }, a);
  G.apply(g, { type: 'call' }, b);
  eq(g.phase, 'gameOver', 'game over');
  eq([G.place(g, a), G.place(g, b)], [1, 2], 'places');
}
// Blinds go up
{
  const g = game(6);
  for (let i = 0; i < 10; i++) { while (g.phase === 'betting') G.apply(g, { type: 'fold' }, g.turn); G.nextHand(g); }
  eq([g.handNumber, G.bigBlind(g)], [11, 30], 'level 2 at hand 11');
}
// Whole bot tournaments: chips stay put, everyone gets a place, every move is legal.
{
  settings.trials = 60;
  const rng = seeded(99);
  for (const players of [6, 9]) {
    const g = G.newGame(players, rng);
    const bots = Array.from({ length: players }, (_, i) => new Bot({ style: STYLE_NAMES[i % STYLE_NAMES.length] }));
    let moves = 0;
    while (g.phase !== 'gameOver' && moves < 100000) {
      if (g.phase === 'handOver') { G.nextHand(g, rng); continue; }
      const m = bots[g.turn].move(g, g.turn, rng);
      G.apply(g, m, g.turn);
      moves++;
    }
    eq(g.seats.reduce((t, s) => t + s.chips, 0), players * G.STARTING_CHIPS, `${players}-player chips`);
    eq(new Set(g.seats.map((_, i) => G.place(g, i))).size, players, `${players}-player places`);
    print(`${players} players: ${g.handNumber} hands, ${moves} moves`);
  }
}
// The table: continue after folding, and pacing.
{
  const seats = [{ kind: 'person', name: 'Me' }, ...Array.from({ length: 5 }, (_, i) => ({ kind: 'bot', name: 'B' + i }))];
  const s = newTableState(seats, 6);
  check(Object.keys(s.game.botStyles).length === 5, 'bots get styles');
  // Fold my way to the end of a hand.
  const g = s.game;
  for (;;) {
    while (g.phase === 'betting') {
      const seat = g.turn;
      applyMove(s, seat === 0 ? { type: 'fold', seat } : { type: G.canCheck(g, seat) ? 'check' : 'fold', seat });
    }
    if (g.seats[0].folded) break;
    applyMove(s, { type: 'deal', hand: g.handNumber });      // Everyone folded to me: try again.
  }
  const step = nextHostStep(s);
  check(step && step.move.type === 'deal' && step.delay > 50000, 'waits for me to continue');
  applyMove(s, { type: 'continue', seat: 0, hand: g.handNumber });
  const after = nextHostStep(s);
  check(after.delay < 5000, 'deals soon after continue');
}

// The hand that knocks me out waits for me, even though only bots are left (Louie, 2026-10-28).
{
  const seats = [{ kind: 'person', name: 'Me' }, ...Array.from({ length: 5 }, (_, i) => ({ kind: 'bot', name: 'B' + i }))];
  const s = newTableState(seats, 6);
  const g = s.game;
  // Everyone gets the same small stack; I hold 7-2 against aces, and we both go all in.
  const holes = g.seats.map(() => []);
  holes[0] = cards('7c 2d');
  const other = (g.turn + 1) % 6 === 0 ? (g.turn + 2) % 6 : (g.turn + 1) % 6;
  holes[other] = cards('As Ah');
  G.rig(g, holes, cards('Kd Qs 9h 5c 3s'));
  let moves = 0;
  while (g.phase === 'betting' && moves++ < 50) {
    const seat = g.turn;
    if (seat === 0 || seat === other) {
      const all = { type: 'raise', seat, to: G.maxRaiseTo(g, seat) };
      applyMove(s, G.canApply(g, all, seat) ? all : { type: G.canCheck(g, seat) ? 'check' : 'call', seat });
    } else applyMove(s, { type: G.canCheck(g, seat) ? 'check' : 'fold', seat });
  }
  check(g.result && g.result.busted.includes(0), 'I got knocked out');
  const step = nextHostStep(s);
  check(step && step.move.type === 'deal' && step.delay > 50000, 'the knockout hand waits for me');
  applyMove(s, { type: 'continue', seat: 0, hand: g.handNumber });
  check(nextHostStep(s).delay < 5000, 'then the bots carry on');
}

// A hand I won (everyone folded to me) waits for me too (Louie, 2026-10-28).
{
  const seats = [{ kind: 'person', name: 'Me' }, ...Array.from({ length: 5 }, (_, i) => ({ kind: 'bot', name: 'B' + i }))];
  const s = newTableState(seats, 6);
  const g = s.game;
  while (g.phase === 'betting') {
    const seat = g.turn;
    applyMove(s, seat === 0 ? { type: G.canCheck(g, seat) ? 'check' : 'call', seat } : { type: 'fold', seat });
  }
  check(!g.seats[0].folded && g.result.won[0] > 0, 'I won the hand');
  const step = nextHostStep(s);
  check(step && step.move.type === 'deal' && step.delay > 50000, 'a win waits for me to continue');
  applyMove(s, { type: 'continue', seat: 0, hand: g.handNumber });
  check(nextHostStep(s).delay < 5000, 'deals soon after continue (won)');
}

// Statistics (handstats.js)
{
  // Aces against kings, all in before the flop: about 82%.
  const g = game(2);
  const a = g.button, b = g.bigBlindSeat;
  const holes = [[], []];
  holes[a] = cards('As Ah'); holes[b] = cards('Kc Kd');
  G.rig(g, holes, cards('2c 7d 9h 3s Kh'));
  G.apply(g, { type: 'raise', to: 1500 }, a);
  G.apply(g, { type: 'call' }, b);
  const equity = allInEquity(g, a, seeded(5));
  check(equity > 0.78 && equity < 0.86, `aces vs kings equity ${equity}`);
  const line = blankLine();
  recordHand(line, g, a, 123, seeded(6));
  eq(line.allIns, { won: 0, lost: 1, badBeats: 1, lucky: 0 }, 'bad beat counted');
  eq(line.worstBeat.hole, cards('As Ah'), 'worst beat hole cards');
  eq(line.starts.AA, { n: 1, w: 0, bb: -75 }, 'aces lost 75 big blinds');
  eq(line.made.c1, 1, 'made a pair');
  const kings = blankLine();
  recordHand(kings, g, b, 123, seeded(6));
  eq([kings.allIns.lucky, kings.made.c3, kings.bestHand.date], [1, 1, 123], 'lucky kings made trips');
  eq(g.knockedOutBy, { [a]: b }, 'who knocked out whom');
  recordRivals(kings, g, b, () => 'rock');
  recordRivals(line, g, a, () => 'shark');
  eq([kings.rivals.outed, line.rivals.outBy], [{ rock: 1 }, { shark: 1 }], 'rivals');
  recordFinish(kings, 1, 6, 5); recordFinish(kings, 1, 6, 6); recordFinish(kings, 4, 9, 7);
  eq([kings.played, kings.won, kings.bestStreak, kings.streak, kings.finishes.six.p1, kings.finishes.nine.p4, kings.recent.length],
    [3, 2, 2, 0, 2, 1, 3], 'finishes');
  // Firebase drops empty objects: normalize fills them back in.
  const back = normalize(JSON.parse(JSON.stringify({ played: 3, style: { dealt: 4 }, recent: { 0: { place: 1 } } })));
  eq([back.played, back.style.dealt, back.style.vpip, back.finishes.six, back.recent.length, back.rivals.outBy], [3, 4, 0, {}, 1, {}], 'normalize');
}
// Every bot's numbers over a tournament: sane, and a style comes out.
{
  settings.trials = 60;
  const rng = seeded(31);
  const g = G.newGame(6, rng);
  const bots = STYLE_NAMES.map((style) => new Bot({ style }));
  const lines = bots.map(() => blankLine());
  while (g.phase !== 'gameOver') {
    if (g.phase === 'handOver') { G.nextHand(g, rng); continue; }
    G.apply(g, bots[g.turn].move(g, g.turn, rng), g.turn);
    if (g.result) lines.forEach((l, i) => recordHand(l, g, i, 0, rng));
  }
  for (const l of lines) {
    const st = l.style;
    check(st.pfr <= st.vpip && st.vpip <= st.dealt && st.wtsd <= st.sawFlop && st.wsd <= st.wtsd, 'style counts in order');
    check(Object.values(l.starts).reduce((t, h) => t + h.n, 0) === st.dealt, 'every hand dealt has a starting hand');
  }
  const most = lines.reduce((a, b) => (a.style.dealt > b.style.dealt ? a : b));
  check(styleNumbers(most) && closestStyle(most), 'a style for the longest survivor');
}

print(`${checks - failures}/${checks} checks passed`);
if (failures) throw new Error(`${failures} failed`);
