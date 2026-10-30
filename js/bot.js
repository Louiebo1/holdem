// The computer players: the app's `Bot`, line for line. A bot decides from what a player at
// the table can see (`playerView`: its own cards and what's public), never anyone else's
// cards or the deck. Each opponent's likely hands are weighted by how they've bet; the bot
// deals out the rest of the hand hundreds of times against those hands for its equity, then
// weighs pot odds, position and stacks — with its style's own leanings.

import { rankOf, suitOf, maskOf } from './cards.js';
import { evaluateMask, category, HIGH_CARD, PAIR, TWO_PAIR, TRIPS } from './evaluator.js';
import { COMBOS, percentile as handPercentile, handLabel } from './preflop.js';
import * as G from './game.js';

const P = (looseness, threeBet, calling, valueMargin, raiseMargin, bluff, cbet, semiBluff, slowPlay, callLoose, bluffRaise, pushFoldBB, sizes, readWeight) =>
  ({ looseness, threeBet, calling, valueMargin, raiseMargin, bluff, cbet, semiBluff, slowPlay, callLoose, bluffRaise, pushFoldBB, sizes, readWeight });

/** Every style is a good player; they differ in how wide they play, how often they bluff,
 *  and how they use their chips. Secret at the table, revealed when the game ends. */
export const STYLES = {
  rock: { title: 'the Rock', blurb: 'Tight and aggressive: plays few hands, but plays them hard. Rarely bluffs.',
    params: P(0.86, 1.0, 0.8, 0.28, 0.52, 0.12, 0.72, 0.4, 0.1, -0.01, 0.03, 13, [0.66, 0.75], 0.35) },
  shark: { title: 'the Shark', blurb: 'Loose and aggressive: plays lots of hands, steals blinds, bluffs and keeps the pressure on.',
    params: P(1.32, 1.6, 1.05, 0.24, 0.46, 0.28, 0.85, 0.7, 0.08, 0.0, 0.12, 12, [0.5, 0.66, 0.8, 1.2], 0.45) },
  trapper: { title: 'the Trapper', blurb: 'Slow-plays big hands and check-raises. A quiet bet can mean a monster.',
    params: P(0.98, 0.6, 1.3, 0.3, 0.5, 0.14, 0.55, 0.45, 0.6, 0.02, 0.05, 11, [0.5, 0.66], 0.35) },
  grinder: { title: 'the Grinder', blurb: 'Steady, by-the-book poker: sensible ranges, balanced bets, few mistakes.',
    params: P(1.0, 1.0, 1.0, 0.28, 0.5, 0.18, 0.7, 0.5, 0.15, 0.0, 0.06, 12, [0.5, 0.66, 0.75], 0.35) },
  bully: { title: 'the Bully', blurb: 'Uses a big stack to push short stacks around, especially near the end.',
    params: P(1.15, 1.3, 0.95, 0.27, 0.48, 0.22, 0.8, 0.6, 0.1, -0.01, 0.08, 13, [0.66, 0.8, 1.0], 0.35) },
  reader: { title: 'the Reader', blurb: 'Watches how everyone plays and adjusts: bluffs players who fold too much, value-bets the ones who call.',
    params: P(1.0, 1.1, 1.0, 0.27, 0.5, 0.18, 0.7, 0.5, 0.2, 0.0, 0.07, 12, [0.5, 0.66, 0.75], 1.0) },
};
export const STYLE_NAMES = Object.keys(STYLES);

// Hand classes, weakest first.
export const AIR = 0, DRAW = 1, WEAK_PAIR = 2, GOOD_PAIR = 3, STRONG = 4;

/** Everything a player at the table can see. */
export function playerView(g, seat) {
  const n = G.playerCount(g);
  return {
    me: seat,
    hole: g.seats[seat].hole.slice(),
    board: g.board.slice(),
    street: g.street,
    pot: G.pot(g),
    toCall: G.toCall(g, seat),
    currentBet: g.currentBet,
    bigBlind: G.bigBlind(g),
    button: g.button,
    bigBlindSeat: g.bigBlindSeat,
    playerCount: n,
    chips: g.seats.map((s) => s.chips),
    bets: g.seats.map((s) => s.bet),
    live: g.seats.map((s) => s.inHand && !s.folded),
    actions: g.actions,
    tendencies: g.tendencies,
    preflopAggressor: g.preflopAggressor,
    canRaise: G.canRaise(g, seat),
    minRaiseTo: G.minRaiseTo(g, seat),
    maxRaiseTo: G.maxRaiseTo(g, seat),
    behind: G.seatsToActAfter(g, seat),
    playersLeft: G.playersLeft(g).length,
  };
}

const opponentsOf = (v) => v.live.map((l, i) => (l && i !== v.me ? i : -1)).filter((i) => i >= 0);
const stackOf = (v, seat) => v.chips[seat] + v.bets[seat];
const effectiveStack = (v) => Math.min(stackOf(v, v.me), Math.max(0, ...opponentsOf(v).map((s) => stackOf(v, s))));
function inPosition(v) {
  const distance = (seat) => (seat - v.button - 1 + v.playerCount) % v.playerCount;
  return opponentsOf(v).every((s) => distance(s) < distance(v.me));
}
const collected = (v) => v.pot - v.bets.reduce((a, b) => a + b, 0);

const rate = (part, whole, min) => (whole >= min ? part / whole : null);
const vpipRate = (t) => rate(t.vpip, t.hands, 4);
const pfrRate = (t) => rate(t.pfr, t.hands, 4);
const foldToBetRate = (t) => rate(t.foldedToBet, t.facedBet, 3);
const aggressionOf = (t) => (t.aggressive + t.passive >= 4 ? t.aggressive / Math.max(1, t.passive) : null);

const POP = new Uint8Array(8192);
for (let i = 1; i < 8192; i++) POP[i] = POP[i >> 1] + (i & 1);
const suitSets = (lo, hi) => [lo & 0x1FFF, (lo >>> 16) & 0x1FFF, hi & 0x1FFF, (hi >>> 16) & 0x1FFF];

/** What a hand amounts to on a board, roughly: what a player would bet or call with. */
export function handClass(lo, hi, board, bLo, bHi, boardScore) {
  const score = evaluateMask(lo | bLo, hi | bHi);
  const cat = category(score), boardCat = category(boardScore);
  const boardTop = board.length ? Math.max(...board.map(rankOf)) : 0;
  const holeSets = suitSets(lo, hi);
  const holeRanks = holeSets[0] | holeSets[1] | holeSets[2] | holeSets[3];
  const hasRank = (r) => (holeRanks & (1 << (r - 2))) !== 0;

  let made = AIR;
  if (cat > boardCat) {
    if (cat >= TRIPS) made = STRONG;
    else if (cat === TWO_PAIR) {
      if (boardCat === PAIR) {
        // The board has the other pair: really one pair.
        const pairRank = ((score >> 16) & 0xF) + 2, second = ((score >> 12) & 0xF) + 2;
        const mine = hasRank(pairRank) ? pairRank : second;
        made = mine >= boardTop ? GOOD_PAIR : WEAK_PAIR;
      } else made = STRONG;
    } else if (cat === PAIR) {
      const pairRank = ((score >> 16) & 0xF) + 2;
      made = pairRank >= boardTop ? GOOD_PAIR : WEAK_PAIR;
    }
  }
  if (made >= GOOD_PAIR || board.length >= 5) return made;
  // Draws: four to a flush, or four in a row.
  const all = suitSets(lo | bLo, hi | bHi);
  for (let s = 0; s < 4; s++) if (POP[all[s]] === 4 && holeSets[s] !== 0) return DRAW;
  const ranks = all[0] | all[1] | all[2] | all[3];
  for (let low = 0; low <= 8; low++) {
    const run = 0xF << low;
    if ((ranks & run) === run && (holeRanks & run) !== 0) return DRAW;
  }
  return made;
}

/** One opponent's likely hands: masks with running weights. */
class HandRange {
  constructor() { this.lo = []; this.hi = []; this.cumulative = []; this.total = 0; }
  add(lo, hi, weight) {
    if (weight <= 0.0005) return;
    this.lo.push(lo); this.hi.push(hi);
    this.total += weight;
    this.cumulative.push(this.total);
  }
  sample(rng) {
    const target = rng.unit() * this.total;
    let low = 0, high = this.cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.cumulative[mid] > target) high = mid; else low = mid + 1;
    }
    return low;
  }
}

const smooth = (x, width) => 1 / (1 + Math.exp(-x / width));

const LIKELIHOOD = {
  bet: (bluff) => [bluff, 0.55, 0.3, 0.75, 1],
  raise: (bluff) => [bluff * 0.6, 0.4, 0.1, 0.4, 1],
  call: () => [0.12, 0.75, 0.6, 0.9, 0.6],
  check: () => [1, 0.8, 0.85, 0.6, 0.4],
};

/** Standard opening ranges by the number of players still to act behind. */
export function openRange(behind, headsUp) {
  if (headsUp) return 0.8;
  const table = [1.0, 0.45, 0.42, 0.28, 0.22, 0.17, 0.14, 0.12, 0.11, 0.1];
  return table[Math.min(behind, table.length - 1)];
}

/** Roughly the all-in-or-fold ranges good short-stacked players use. */
export function pushRange(bigBlinds, behind, headsUp = false) {
  const table = [1.0, 0.55, 0.38, 0.28, 0.22, 0.18, 0.16, 0.14, 0.13, 0.12];
  const base = headsUp ? 0.68 : table[Math.min(behind, table.length - 1)];
  return Math.min(1, base * Math.pow(10 / Math.max(1, bigBlinds), 0.8));
}

/** Deals simulated per decision after the flop (tests turn this down for speed). */
export const settings = { trials: 700, bluffPrior: 0.24 };

const defaultRng = { below: (n) => Math.floor(Math.random() * n), unit: () => Math.random() };

export class Bot {
  constructor({ style = 'grinder' } = {}) {
    this.style = STYLES[style] ? style : 'grinder';
    this.params = STYLES[this.style].params;
  }

  move(g, seat, rng = defaultRng) {
    const v = playerView(g, seat);
    const m = v.street === G.PREFLOP ? this.preflop(v, rng) : this.postflop(v, rng);
    return this.legal(m, g, seat);
  }

  /** Makes sure a move is allowed, turning anything off into the nearest legal move. */
  legal(m, g, seat) {
    if (G.canApply(g, m, seat)) return m;
    const checkOr = (other) => (G.canCheck(g, seat) ? { type: 'check' } : { type: other });
    if (m.type === 'raise') {
      if (G.canRaise(g, seat)) {
        const fixed = Math.max(G.minRaiseTo(g, seat), Math.min(m.to, G.maxRaiseTo(g, seat)));
        if (G.canApply(g, { type: 'raise', to: fixed }, seat)) return { type: 'raise', to: fixed };
      }
      return checkOr('call');
    }
    return checkOr('fold');
  }

  // MARK: Reading opponents

  observed(value, prior, count) {
    if (value === null) return prior;
    const trust = count / (count + 30 * (1.1 - this.params.readWeight));
    return prior + (value - prior) * trust;
  }

  /** The hands `seat` likely holds, from its preflop action and its bets since. */
  range(seat, v) {
    const t = v.tendencies[seat];
    const vpip = this.observed(vpipRate(t), v.playerCount > 6 ? 0.24 : 0.28, t.hands);
    const pfr = this.observed(pfrRate(t), v.playerCount > 6 ? 0.15 : 0.18, t.hands);
    const aggression = this.observed(aggressionOf(t), 1.5, t.aggressive + t.passive);
    const caught = t.showdowns > 0 ? t.bluffsShown / t.showdowns : 0;
    const bluff = Math.min(0.5, settings.bluffPrior * Math.max(0.4, aggression / 1.5) + caught * this.params.readWeight * 0.3);

    // Before the flop: the share of hands it would play the way it did.
    let cutoff = 1, exclude = 0, excludeWeight = 0;
    const pre = v.actions.filter((a) => a.seat === seat && a.street === G.PREFLOP && a.kind !== 'smallBlind' && a.kind !== 'bigBlind');
    const last = pre[pre.length - 1];
    if (last) {
      const bbs = last.amount / v.bigBlind;
      if (last.kind === 'bet' || (last.kind === 'raise' && last.raisesBefore === 1)) {
        cutoff = pfr;
        if (last.allIn && bbs < 15) cutoff = Math.max(cutoff, pushRange(bbs, 3));
      } else if (last.kind === 'raise' && last.raisesBefore === 2) {
        cutoff = Math.max(0.03, pfr * 0.35);
        if (last.allIn && bbs < 20) cutoff = Math.max(cutoff, 0.12);
      } else if (last.kind === 'raise') {
        cutoff = last.allIn ? 0.06 : 0.035;
      } else if (last.kind === 'call' && last.raisesBefore === 1) {
        cutoff = Math.min(0.75, vpip * 1.6); exclude = pfr * 0.5; excludeWeight = 0.7;
      } else if (last.kind === 'call' && last.raisesBefore === 2) {
        cutoff = Math.max(0.08, vpip * 0.8); exclude = 0.04; excludeWeight = 0.5;
      } else if (last.kind === 'call') {
        cutoff = 0.09; exclude = 0.02; excludeWeight = 0.5;
      } else if (last.kind === 'check') {
        cutoff = 1; exclude = 0.12; excludeWeight = 0.7;
      }
    }

    // After the flop: what it did on each street, judged on the board as it was then.
    const streets = [];
    for (const street of [G.FLOP, G.TURN, G.RIVER]) {
      if (street > v.street) break;
      const mine = v.actions.filter((a) => a.seat === seat && a.street === street);
      if (!mine.length) continue;
      const cards = v.board.slice(0, street === G.FLOP ? 3 : street === G.TURN ? 4 : 5);
      const has = (k) => mine.some((a) => a.kind === k);
      const strongest = has('raise') ? 'raise' : has('bet') ? 'bet' : has('call') ? 'call' : 'check';
      const m = maskOf(cards);
      streets.push({ cards, lo: m.lo, hi: m.hi, score: evaluateMask(m.lo, m.hi), likely: LIKELIHOOD[strongest](bluff) });
    }

    const dead = maskOf([...v.hole, ...v.board]);
    const range = new HandRange();
    for (const c of COMBOS) {
      if ((c.lo & dead.lo) || (c.hi & dead.hi)) continue;
      let weight = smooth(cutoff - c.percentile, 0.025);
      if (excludeWeight > 0) weight *= 1 - excludeWeight * smooth(exclude - c.percentile, 0.01);
      for (const s of streets) weight *= s.likely[handClass(c.lo, c.hi, s.cards, s.lo, s.hi, s.score)];
      range.add(c.lo, c.hi, weight);
    }
    return range;
  }

  /** My share of the pot if everyone still in turns their cards up after the river. */
  equity(v, trials, rng) {
    const opponents = opponentsOf(v);
    if (!opponents.length) return 1;
    const ranges = opponents.map((s) => this.range(s, v));
    const mine = maskOf(v.hole), board = maskOf(v.board);
    const missing = 5 - v.board.length;
    const handsLo = new Int32Array(opponents.length), handsHi = new Int32Array(opponents.length);
    let total = 0;
    for (let trial = 0; trial < trials; trial++) {
      let usedLo = mine.lo | board.lo, usedHi = mine.hi | board.hi;
      for (let k = 0; k < ranges.length; k++) {
        const r = ranges[k];
        let lo = 0, hi = 0, found = false;
        for (let tries = 0; tries < 12 && r.total > 0; tries++) {
          const i = r.sample(rng);
          if (!(r.lo[i] & usedLo) && !(r.hi[i] & usedHi)) { lo = r.lo[i]; hi = r.hi[i]; found = true; break; }
        }
        if (!found) [lo, hi] = randomCards(2, usedLo, usedHi, rng);
        usedLo |= lo; usedHi |= hi;
        handsLo[k] = lo; handsHi[k] = hi;
      }
      const [rLo, rHi] = randomCards(missing, usedLo, usedHi, rng);
      const bLo = board.lo | rLo, bHi = board.hi | rHi;
      const me = evaluateMask(mine.lo | bLo, mine.hi | bHi);
      let ties = 1, lost = false;
      for (let k = 0; k < ranges.length; k++) {
        const s = evaluateMask(handsLo[k] | bLo, handsHi[k] | bHi);
        if (s > me) { lost = true; break; }
        if (s === me) ties++;
      }
      if (!lost) total += 1 / ties;
    }
    return total / trials;
  }

  // MARK: Before the flop

  coverage(v) {
    const biggest = Math.max(1, ...opponentsOf(v).map((s) => stackOf(v, s)));
    return stackOf(v, v.me) / biggest;
  }

  raiseAmount(target, v) {
    if (!v.canRaise) return { type: v.toCall > 0 ? 'call' : 'check' };
    const unit = Math.max(1, v.bigBlind / 2);
    let to = Math.round(target / unit) * unit;
    to = Math.max(v.minRaiseTo, Math.min(to, v.maxRaiseTo));
    // Most of my stack anyway: just go all in.
    if (to >= v.maxRaiseTo * 0.6) to = v.maxRaiseTo;
    return { type: 'raise', to };
  }

  preflop(v, rng) {
    const p = this.params, style = this.style;
    const pct = handPercentile(v.hole[0], v.hole[1]);
    // A little mixing at the edges of each range, so the bots aren't mechanical.
    const plays = (range) => rng.unit() < smooth(range - pct, 0.012);
    const bb = v.bigBlind;
    const effectiveBB = effectiveStack(v) / bb;
    const raises = v.actions.filter((a) => a.street === G.PREFLOP && a.kind === 'raise').length;
    const limpers = v.actions.filter((a) => a.street === G.PREFLOP && a.kind === 'call').length;
    const headsUp = v.playersLeft === 2;
    const stack = stackOf(v, v.me);
    let looseness = p.looseness;
    if (style === 'bully' && this.coverage(v) > 1.3) looseness *= 1.3;
    // Reader: open wider when the blinds fold too much, tighter when they defend.
    if (style === 'reader') {
      const r = this.blindsFoldRate(v);
      if (r !== null) looseness *= 0.8 + r * 0.5;
    }

    // A big decision (an all-in, or most of my stack): work out the equity.
    const opponentAllIn = opponentsOf(v).some((s) => v.chips[s] === 0 && v.bets[s] > v.bets[v.me]);
    if (v.toCall > 0 && (opponentAllIn || v.toCall >= stack * 0.3)) {
      const e = this.equity(v, Math.max(250, Math.floor(settings.trials / 2)), rng);
      const odds = v.toCall / (v.pot + v.toCall);
      let margin = style === 'rock' ? 0.02 : style === 'bully' && this.coverage(v) > 1.5 ? -0.02 : 0.01;
      if (v.playersLeft <= 3) margin -= 0.01;
      if (e > odds + margin) {
        return effectiveBB < p.pushFoldBB * 1.5 && v.canRaise && e > 0.55 ? { type: 'raise', to: v.maxRaiseTo } : { type: 'call' };
      }
      return { type: 'fold' };
    }

    if (raises === 0) {
      if (effectiveBB <= p.pushFoldBB * (style === 'bully' && this.coverage(v) > 1.3 ? 1.2 : 1)) {
        let push = pushRange(effectiveBB, v.behind, headsUp) * Math.sqrt(looseness);
        if (limpers > 0) push *= 0.7;
        if (plays(push)) return { type: 'raise', to: v.maxRaiseTo };
        return { type: v.toCall === 0 ? 'check' : 'fold' };
      }
      let open = openRange(v.behind, headsUp) * looseness;
      if (limpers > 0) open *= 0.75;
      if (plays(open)) {
        const size = (style === 'shark' ? 2.2 : style === 'rock' ? 2.5 : 2.3) + limpers;
        const sb = v.me !== v.bigBlindSeat && v.bets[v.me] < v.bigBlind && v.bets[v.me] > 0 && !headsUp;
        return this.raiseAmount(bb * (sb ? size + 0.7 : size), v);
      }
      if (v.toCall === 0) return { type: 'check' };
      // Complete the small blind or limp behind with something playable when it's cheap.
      if ((limpers > 0 || v.bets[v.me] > 0) && v.toCall <= bb && plays(open * 1.6)) return { type: 'call' };
      return { type: 'fold' };
    }

    // Facing a raise. Who raised, and how wide they open.
    const raiser = v.actions.filter((a) => a.street === G.PREFLOP && a.kind === 'raise').pop().seat;
    const rt = v.tendencies[raiser];
    const raiserPFR = this.observed(pfrRate(rt), 0.18, rt.hands);
    const steal = raiserPFR > 0.28 || v.actions.filter((a) => a.street === G.PREFLOP && a.kind === 'fold').length >= v.playerCount - 3;
    const inPos = v.behind === 0 || v.me === v.button;
    const bigBlindDefense = v.me === v.bigBlindSeat ? 1.6 : 1;
    const odds = v.toCall / (v.pot + v.toCall);

    if (raises === 1) {
      let threeBet = 0.045 * p.threeBet * (steal ? 1.6 : 1);
      if (style === 'bully' && this.coverage(v) > 1.3) threeBet *= 1.3;
      let call = 0.16 * p.calling * (inPos ? 1.2 : 0.85) * bigBlindDefense * (odds < 0.25 ? 1.25 : 1);
      if (effectiveBB < 25) call *= 0.8;
      if (effectiveBB <= p.pushFoldBB * 1.6 && plays(threeBet * 2.6)) return { type: 'raise', to: v.maxRaiseTo };
      if (plays(threeBet)) {
        return this.raiseAmount(v.currentBet * (inPos ? 3 : 3.6) + limpers * v.currentBet, v);
      }
      // A light 3-bet now and then from just outside the calling range.
      const suited = suitOf(v.hole[0]) === suitOf(v.hole[1]);
      if (suited && pct > call && pct < call * 1.8 && rng.unit() < p.bluff * 0.35 * (steal ? 1.5 : 1)) {
        return this.raiseAmount(v.currentBet * 3.2, v);
      }
      // Small pairs can call to hit a set when the stacks are deep.
      const pair = rankOf(v.hole[0]) === rankOf(v.hole[1]);
      if (plays(call) || (pair && effectiveBB > 25 && v.toCall < effectiveStack(v) * 0.07)) return { type: 'call' };
      return { type: v.toCall === 0 ? 'check' : 'fold' };
    }

    // Facing a 3-bet or more.
    const fourBet = 0.025 * (style === 'rock' ? 0.8 : style === 'shark' ? 1.3 : 1);
    if (plays(fourBet)) return this.raiseAmount(v.currentBet * 2.3, v);
    if (plays(0.065 * p.calling) && v.toCall < stack * 0.25) return { type: 'call' };
    return { type: v.toCall === 0 ? 'check' : 'fold' };
  }

  /** Reader: how often the blinds have been folding to steals. */
  blindsFoldRate(v) {
    const blinds = [v.bigBlindSeat, (v.bigBlindSeat - 1 + v.playerCount) % v.playerCount];
    const rates = blinds.map((s) => vpipRate(v.tendencies[s])).filter((r) => r !== null);
    if (!rates.length) return null;
    return 1 - rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  // MARK: After the flop

  postflop(v, rng) {
    const p = this.params, style = this.style;
    const opponents = opponentsOf(v);
    const n = opponents.length;
    const e = this.equity(v, settings.trials, rng);
    const fairShare = 1 / (n + 1);
    const hm = maskOf(v.hole), bm = maskOf(v.board);
    const mine = handClass(hm.lo, hm.hi, v.board, bm.lo, bm.hi, evaluateMask(bm.lo, bm.hi));
    const pot = v.pot;
    const random = () => rng.unit();
    const size = () => p.sizes[rng.below(p.sizes.length)];

    // How often these opponents fold to a bet (watched, blended with typical play).
    const foldRates = opponents.map((s) => this.observed(foldToBetRate(v.tendencies[s]), 0.42, v.tendencies[s].facedBet));
    const foldFactor = Math.max(0.3, Math.min(2.2, foldRates.reduce((a, b) => a * b, 1) / Math.pow(0.42, n)));
    let bluffFactor = foldFactor;
    // Bully: lean on the short stacks.
    if (style === 'bully') {
      const cover = this.coverage(v);
      if (cover > 1.5) bluffFactor *= 1.6; else if (cover < 0.8) bluffFactor *= 0.7;
    }
    // Reader: no bluffing players who never fold; thinner value bets against them.
    let valueMargin = p.valueMargin;
    if (style === 'reader' && foldFactor < 0.7) { bluffFactor *= 0.5; valueMargin *= 0.85; }

    const valueEquity = fairShare + (1 - fairShare) * valueMargin * (v.street === G.RIVER && n === 1 ? 0.8 : 1);
    const raiseEquity = fairShare + (1 - fairShare) * p.raiseMargin;
    const iChecked = v.actions.some((a) => a.seat === v.me && a.street === v.street && a.kind === 'check');

    if (v.toCall === 0) {
      if (e >= valueEquity) {
        // Trap: check a monster and let them bet.
        if (e > 0.82 && v.street < G.RIVER && random() < p.slowPlay) return { type: 'check' };
        return this.raiseAmount(pot * size() * (mine === STRONG ? 1.1 : 1), v);
      }
      if (v.preflopAggressor === v.me && v.street === G.FLOP && n <= 2 && random() < p.cbet * (n === 1 ? 1 : 0.55) * Math.min(1.3, foldFactor)) {
        return this.raiseAmount(pot * (style === 'shark' ? 0.33 : 0.45), v);
      }
      if (mine === DRAW && random() < p.semiBluff * (n === 1 ? 1 : 0.6)) return this.raiseAmount(pot * size(), v);
      const positionBoost = inPosition(v) ? 1.3 : 0.8;
      if (mine <= WEAK_PAIR && random() < p.bluff * bluffFactor * (n === 1 ? 1 : 0.3) * positionBoost * (v.street === G.RIVER ? 0.8 : 1)) {
        return this.raiseAmount(pot * size(), v);
      }
      return { type: 'check' };
    }

    // Facing a bet.
    const odds = v.toCall / (pot + v.toCall);
    const behind = v.chips[v.me];
    const implied = mine === DRAW && v.street < G.RIVER ? 0.05 * Math.min(1, behind / Math.max(1, pot) / 3) : 0;
    if (e >= raiseEquity && v.canRaise) {
      // The Trapper keeps calling with a monster on early streets — unless it checked to
      // set up a check-raise.
      if (style === 'trapper' && !iChecked && v.street < G.RIVER && random() < 0.5) return { type: 'call' };
      return this.raiseAmount(v.currentBet * 2.8 + collected(v) * 0.25, v);
    }
    if (e + p.callLoose + implied >= odds) return { type: 'call' };
    if (mine === DRAW && v.canRaise && n === 1 && v.street < G.RIVER && random() < p.bluffRaise * bluffFactor) {
      return this.raiseAmount(v.currentBet * 2.8, v);
    }
    return { type: 'fold' };
  }
}

function randomCards(count, usedLo, usedHi, rng) {
  let lo = 0, hi = 0, picked = 0;
  while (picked < count) {
    const index = rng.below(52);
    const suit = Math.floor(index / 13), bit = 1 << ((suit & 1) * 16 + (index % 13));
    if (suit >> 1) { if ((usedHi | hi) & bit) continue; hi |= bit; }
    else { if ((usedLo | lo) & bit) continue; lo |= bit; }
    picked++;
  }
  return [lo, hi];
}

/** What a good, steady player would do here, and why (the app's Suggest). */
export function advice(g, seat, rng = defaultRng) {
  const bot = new Bot({ style: 'grinder' });
  const v = playerView(g, seat);
  const m = bot.move(g, seat, rng);
  const what = m.type === 'fold' ? 'Fold' : m.type === 'check' ? 'Check' : m.type === 'call' ? `Call ${G.toCall(g, seat).toLocaleString()}`
    : m.to === G.maxRaiseTo(g, seat) ? 'Go all in' : `${g.currentBet === 0 ? 'Bet' : 'Raise to'} ${m.to.toLocaleString()}`;
  if (v.street === G.PREFLOP) {
    const top = Math.max(1, Math.round(handPercentile(v.hole[0], v.hole[1]) * 100));
    return `${what}. ${handLabel(v.hole[0], v.hole[1])} is in the top ${top}% of starting hands.`;
  }
  const e = bot.equity(v, 1500, rng);
  let line = `${what}. You win about ${Math.round(e * 100)}% of the time against the hands they're likely to have`;
  const owe = G.toCall(g, seat);
  if (owe > 0) line += `, and calling needs ${Math.round((owe / (G.pot(g) + owe)) * 100)}%`;
  return line + '.';
}

export { HIGH_CARD };
