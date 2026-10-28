// No-Limit Texas Hold'em sit-and-go: the app's `HoldemGame`, as plain JSON state.
// Everyone starts with the same chips, the blinds go up every few hands, and the last
// player with chips wins. The deck is part of the state. Illegal moves throw IllegalMove.
// Moves: { type: 'fold' | 'check' | 'call' } or { type: 'raise', to } (the seat's whole bet
// on the street after raising; all-in if that's every chip).

import { FULL_DECK, shuffled, mathRandom } from './cards.js';
import { evaluate, handName, category, PAIR } from './evaluator.js';

export class IllegalMove extends Error {}

export const PREFLOP = 0, FLOP = 1, TURN = 2, RIVER = 3;
export const STREET_NAME = ['Preflop', 'Flop', 'Turn', 'River'];
/** Big blinds by level; the small blind is half. */
export const BLIND_LEVELS = [20, 30, 40, 60, 80, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200,
  1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000, 30000];
export const STARTING_CHIPS = 1500;
export const handsPerLevelFor = (players) => (players > 6 ? 12 : 10);

const blankTendencies = () => ({ hands: 0, vpip: 0, pfr: 0, aggressive: 0, passive: 0, facedBet: 0, foldedToBet: 0, showdowns: 0, bluffsShown: 0 });

export function newGame(players, rng = mathRandom, startingChips = STARTING_CHIPS, handsPerLevel = null) {
  const g = {
    seats: Array.from({ length: players }, () => ({ chips: startingChips, hole: [], inHand: false, folded: false, bet: 0, committed: 0, actedAt: null, out: false, startChips: 0 })),
    phase: 'betting', street: PREFLOP, board: [], deck: [],
    button: rng.below(players), smallBlindSeat: 0, bigBlindSeat: 0, turn: 0,
    currentBet: 0, minRaise: 0, fullRaiseLevel: 0, handNumber: 0,
    handsPerLevel: handsPerLevel || handsPerLevelFor(players),
    actions: [], preflopAggressor: null, result: null, revealed: [], runoutFrom: null, knockedOut: [], knockedOutBy: {},
    tendencies: Array.from({ length: players }, blankTendencies), vpipThisHand: [], pfrThisHand: [],
    humanSeats: [0], botStyles: {},
  };
  startHand(g, rng, false);
  return g;
}

// MARK: Reading the table

export const playerCount = (g) => g.seats.length;
export const level = (g) => Math.min(Math.floor((Math.max(1, g.handNumber) - 1) / g.handsPerLevel), BLIND_LEVELS.length - 1);
export const bigBlind = (g) => BLIND_LEVELS[level(g)];
export const smallBlind = (g) => bigBlind(g) / 2;
export const handsUntilLevel = (g) => g.handsPerLevel - ((Math.max(1, g.handNumber) - 1) % g.handsPerLevel);
export const pot = (g) => g.seats.reduce((t, s) => t + s.committed, 0);
export const playersLeft = (g) => g.seats.map((s, i) => (s.out ? -1 : i)).filter((i) => i >= 0);
export const winner = (g) => (g.phase === 'gameOver' ? playersLeft(g)[0] : null);

const live = (s) => s.inHand && !s.folded;
const canAct = (s) => live(s) && s.chips > 0;
export const isLive = (g, seat) => live(g.seats[seat]);
export const isAllIn = (g, seat) => live(g.seats[seat]) && g.seats[seat].chips === 0;
export const liveSeats = (g) => g.seats.map((s, i) => (live(s) ? i : -1)).filter((i) => i >= 0);

/** Where a seat finished: 1 for the winner, null while still playing. */
export function place(g, seat) {
  if (winner(g) === seat) return 1;
  const i = g.knockedOut.indexOf(seat);
  return i < 0 ? null : playerCount(g) - i;
}

export const toCall = (g, seat) => Math.max(0, g.currentBet - g.seats[seat].bet);
export const canCheck = (g, seat) => toCall(g, seat) === 0;
export const maxRaiseTo = (g, seat) => g.seats[seat].bet + g.seats[seat].chips;

export function canRaise(g, seat) {
  const s = g.seats[seat];
  if (!canAct(s) || s.chips <= toCall(g, seat)) return false;
  if (!g.seats.some((o, i) => i !== seat && canAct(o))) return false;
  return s.actedAt === null || s.actedAt < g.fullRaiseLevel;
}

export function minRaiseTo(g, seat) {
  const target = g.currentBet === 0 ? bigBlind(g) : g.currentBet + g.minRaise;
  return Math.min(target, maxRaiseTo(g, seat));
}

export function canApply(g, move, seat) {
  if (g.phase !== 'betting' || seat !== g.turn || !g.seats[seat] || !canAct(g.seats[seat])) return false;
  switch (move.type) {
    case 'fold': return true;
    case 'check': return toCall(g, seat) === 0;
    case 'call': return toCall(g, seat) > 0;
    case 'raise': {
      const to = move.to;
      if (!Number.isInteger(to) || !canRaise(g, seat) || to <= g.currentBet || to > maxRaiseTo(g, seat)) return false;
      return to >= minRaiseTo(g, seat) || to === maxRaiseTo(g, seat);
    }
    default: return false;
  }
}

function needsAction(g, seat) {
  const s = g.seats[seat];
  if (!canAct(s)) return false;
  if (s.bet < g.currentBet) return true;
  if (s.actedAt !== null) return false;
  return g.seats.some((o, i) => i !== seat && canAct(o));
}

export function nextSeat(g, seat, test) {
  const n = playerCount(g);
  for (let step = 1; step <= n; step++) {
    const c = (seat + step) % n;
    if (test(g.seats[c])) return c;
  }
  return null;
}

/** Players still to act after `seat` on this street. */
export function seatsToActAfter(g, seat) {
  const n = playerCount(g);
  let count = 0;
  for (let step = 1; step < n; step++) {
    const s = g.seats[(seat + step) % n];
    if (canAct(s) && (s.actedAt === null || s.bet < g.currentBet)) count++;
  }
  return count;
}

// MARK: Dealing

export function nextHand(g, rng = mathRandom) {
  if (g.phase !== 'handOver') throw new IllegalMove('The hand is not over.');
  startHand(g, rng, true);
}

function startHand(g, rng, moveButton) {
  g.handNumber += 1;
  Object.assign(g, { phase: 'betting', street: PREFLOP, board: [], actions: [], result: null, revealed: [], runoutFrom: null,
    preflopAggressor: null, vpipThisHand: [], pfrThisHand: [] });
  g.seats.forEach((s, i) => {
    Object.assign(s, { hole: [], folded: false, bet: 0, committed: 0, actedAt: null, inHand: !s.out, startChips: s.chips });
    if (s.inHand) g.tendencies[i].hands += 1;
  });
  if (moveButton || g.seats[g.button].out) g.button = nextSeat(g, g.button, (s) => !s.out) ?? g.button;
  g.deck = shuffled(FULL_DECK, rng);
  let seat = g.button;
  const count = playersLeft(g).length;
  for (let round = 0; round < 2; round++) {
    for (let k = 0; k < count; k++) {
      seat = nextSeat(g, seat, (s) => s.inHand);
      g.seats[seat].hole.push(g.deck.pop());
    }
  }
  if (count === 2) {
    // Heads-up the button posts the small blind and acts first before the flop.
    g.smallBlindSeat = g.button;
    g.bigBlindSeat = nextSeat(g, g.button, (s) => s.inHand);
  } else {
    g.smallBlindSeat = nextSeat(g, g.button, (s) => s.inHand);
    g.bigBlindSeat = nextSeat(g, g.smallBlindSeat, (s) => s.inHand);
  }
  post(g, g.smallBlindSeat, smallBlind(g), 'smallBlind');
  post(g, g.bigBlindSeat, bigBlind(g), 'bigBlind');
  g.currentBet = bigBlind(g);
  g.minRaise = bigBlind(g);
  g.fullRaiseLevel = bigBlind(g);
  const first = nextToAct(g, g.bigBlindSeat);
  if (first !== null) g.turn = first;
  else finishStreet(g);
}

function post(g, seat, amount, kind) {
  const paid = Math.min(amount, g.seats[seat].chips);
  put(g, seat, paid);
  g.actions.push({ seat, street: PREFLOP, kind, amount: paid, raisesBefore: 0, allIn: g.seats[seat].chips === 0 });
}

function put(g, seat, amount) {
  const s = g.seats[seat];
  s.chips -= amount; s.bet += amount; s.committed += amount;
}

function nextToAct(g, seat) {
  const n = playerCount(g);
  for (let step = 1; step <= n; step++) {
    const c = (seat + step) % n;
    if (needsAction(g, c)) return c;
  }
  return null;
}

// MARK: Moves

export function apply(g, move, seat) {
  if (!canApply(g, move, seat)) throw new IllegalMove(`Can't ${move.type} now.`);
  const owed = toCall(g, seat);
  const t = g.tendencies[seat];
  const raisesBefore = g.actions.filter((a) => a.street === g.street && (a.kind === 'bet' || a.kind === 'raise')).length
    + (g.street === PREFLOP ? 1 : 0);      // The big blind counts as the first bet.
  let kind;
  switch (move.type) {
    case 'fold':
      g.seats[seat].folded = true;
      kind = 'fold';
      if (g.street !== PREFLOP && owed > 0) { t.facedBet += 1; t.foldedToBet += 1; }
      break;
    case 'check':
      kind = 'check';
      break;
    case 'call':
      put(g, seat, Math.min(owed, g.seats[seat].chips));
      kind = 'call';
      if (g.street === PREFLOP) vpip(g, seat);
      else { t.facedBet += 1; t.passive += 1; }
      break;
    case 'raise': {
      const raiseBy = move.to - g.currentBet;
      put(g, seat, move.to - g.seats[seat].bet);
      if (raiseBy >= g.minRaise) { g.minRaise = raiseBy; g.fullRaiseLevel = move.to; }
      kind = g.currentBet === 0 ? 'bet' : 'raise';
      g.currentBet = move.to;
      if (g.street === PREFLOP) {
        vpip(g, seat);
        if (!g.pfrThisHand.includes(seat)) { g.pfrThisHand.push(seat); t.pfr += 1; }
        g.preflopAggressor = seat;
      } else {
        if (owed > 0) t.facedBet += 1;
        t.aggressive += 1;
      }
      break;
    }
  }
  g.seats[seat].actedAt = g.currentBet;
  g.actions.push({ seat, street: g.street, kind, amount: g.seats[seat].bet, raisesBefore, allIn: isAllIn(g, seat) });

  if (liveSeats(g).length === 1) awardUncontested(g);
  else {
    const next = nextToAct(g, seat);
    if (next !== null) g.turn = next;
    else finishStreet(g);
  }
}

function vpip(g, seat) {
  if (g.vpipThisHand.includes(seat)) return;
  g.vpipThisHand.push(seat);
  g.tendencies[seat].vpip += 1;
}

/** The betting on this street is done: deal the next card(s), or go to the showdown. */
function finishStreet(g) {
  for (;;) {
    if (g.street === RIVER) { showdown(g); return; }
    for (const s of g.seats) { s.bet = 0; s.actedAt = null; }
    g.currentBet = 0;
    g.minRaise = bigBlind(g);
    g.fullRaiseLevel = 0;
    g.street += 1;
    g.deck.pop();                                   // Burn a card.
    for (let i = 0; i < (g.street === FLOP ? 3 : 1); i++) g.board.push(g.deck.pop());
    const first = nextToAct(g, g.button);
    if (first !== null) { g.turn = first; return; }
    // Nobody can bet any more: everyone's cards go face up while the board runs out.
    if (g.runoutFrom === null) g.runoutFrom = g.board.length - (g.street === FLOP ? 3 : 1);
    g.revealed = liveSeats(g);
  }
}

function awardUncontested(g) {
  const w = liveSeats(g)[0];
  const total = pot(g);
  g.seats[w].chips += total;
  g.result = { pots: [{ amount: total, eligible: [w], winners: [w], hand: null }], won: { [w]: total }, showdown: false, shown: [], busted: [] };
  endHand(g);
}

const distanceFromButton = (g, seat) => (seat - g.button - 1 + playerCount(g)) % playerCount(g);

function showdown(g) {
  const liveList = liveSeats(g);
  const scores = {};
  for (const s of liveList) scores[s] = evaluate([...g.seats[s].hole, ...g.board]);
  // Side pots: each layer of chips goes to the best hand among those who put that much in.
  const remaining = g.seats.map((s) => s.committed);
  const pots = [];
  for (;;) {
    const levels = liveList.map((s) => remaining[s]).filter((v) => v > 0);
    if (!levels.length) break;
    const lvl = Math.min(...levels);
    const eligible = liveList.filter((s) => remaining[s] > 0);
    let amount = 0;
    for (let i = 0; i < remaining.length; i++) {
      const part = Math.min(remaining[i], lvl);
      amount += part; remaining[i] -= part;
    }
    pots.push({ amount, eligible, winners: [], hand: null });
  }
  const leftover = remaining.reduce((a, b) => a + b, 0);
  if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;

  const won = {};
  for (const p of pots) {
    const best = Math.max(...p.eligible.map((s) => scores[s]));
    // Odd chips go to the first winners left of the button.
    const winners = p.eligible.filter((s) => scores[s] === best).sort((a, b) => distanceFromButton(g, a) - distanceFromButton(g, b));
    p.winners = winners;
    if (p.eligible.length > 1) p.hand = handName(best);
    const share = Math.floor(p.amount / winners.length);
    let odd = p.amount % winners.length;
    for (const s of winners) {
      const take = share + (odd > 0 ? 1 : 0);
      odd = Math.max(0, odd - 1);
      g.seats[s].chips += take;
      won[s] = (won[s] || 0) + take;
    }
  }
  // Everyone who went to a showdown for chips shows; a lone uncalled all-in doesn't need to.
  const contested = pots.some((p) => p.eligible.length > 1);
  const shown = contested ? liveList : [];
  g.revealed = shown.slice();
  for (const s of shown) {
    g.tendencies[s].showdowns += 1;
    const bet = g.actions.some((a) => a.seat === s && a.street !== PREFLOP && (a.kind === 'bet' || a.kind === 'raise'));
    if (bet && category(scores[s]) <= PAIR && !pots.some((p) => p.winners.includes(s))) g.tendencies[s].bluffsShown += 1;
  }
  g.result = { pots, won, showdown: contested, shown, busted: [] };
  endHand(g);
}

function endHand(g) {
  for (const s of g.seats) s.bet = 0;
  // Knocked out: whoever started the hand with fewer chips goes out first.
  const busted = g.seats.map((s, i) => (s.inHand && s.chips === 0 && !s.out ? i : -1)).filter((i) => i >= 0)
    .sort((a, b) => g.seats[a].startChips - g.seats[b].startChips);
  for (const s of busted) { g.seats[s].out = true; g.knockedOut.push(s); }
  // Who knocked each one out: the winner of the last pot they were in (for the statistics).
  g.knockedOutBy ||= {};
  for (const s of busted) {
    const lastPot = [...g.result.pots].reverse().find((p) => p.eligible.includes(s));
    if (lastPot && lastPot.winners.length) g.knockedOutBy[s] = lastPot.winners[0];
  }
  g.result.busted = busted;
  g.phase = playersLeft(g).length <= 1 ? 'gameOver' : 'handOver';
}

// MARK: Testing

/** Tests only: give seats exact hole cards (and stacks behind their blinds), and stack the
 *  deck so the board comes out as `fullBoard`. */
export function rig(g, holes, fullBoard, chips = null) {
  if (chips) g.seats.forEach((s, i) => { s.chips = chips[i]; });
  holes.forEach((h, i) => { if (h && h.length) g.seats[i].hole = h.slice(); });
  const used = new Set([...holes.flat(), ...fullBoard]);
  const rest = FULL_DECK.filter((c) => !used.has(c));
  const burns = [rest.pop(), rest.pop(), rest.pop()];
  let topCards = [burns[0], ...fullBoard.slice(0, 3)];
  if (fullBoard.length > 3) topCards.push(burns[1], fullBoard[3]);
  if (fullBoard.length > 4) topCards.push(burns[2], fullBoard[4]);
  g.deck = [...rest, ...topCards.reverse()];
}
