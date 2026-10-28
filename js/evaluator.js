// Scores a poker hand of up to 7 cards (the app's `HandEvaluator`): a higher score is a
// better hand. Score = category << 20, then up to five ranks (0 = deuce … 12 = ace), four
// bits each. Works on masks (cards.js) with bit tricks so the bots can score fast.

import { maskOf, rankName, rankPlural, rankOf } from './cards.js';

export const CATEGORY = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
export const HIGH_CARD = 0, PAIR = 1, TWO_PAIR = 2, TRIPS = 3, STRAIGHT = 4, FLUSH = 5, FULL_HOUSE = 6, QUADS = 7, STRAIGHT_FLUSH = 8;

/** For each 13-bit rank set: 1 + the top rank of its best straight, or 0. */
const STRAIGHTS = new Uint8Array(8192);
for (let set = 0; set < 8192; set++) {
  let v = 0;
  for (let high = 12; high >= 4; high--) {
    const run = 0x1F << (high - 4);
    if ((set & run) === run) { v = high + 1; break; }
  }
  if (!v && (set & 0x100F) === 0x100F) v = 4;       // A-2-3-4-5: five high.
  STRAIGHTS[set] = v;
}

const highest = (bits) => 31 - Math.clz32(bits);
const POP = new Uint8Array(8192);
for (let i = 1; i < 8192; i++) POP[i] = POP[i >> 1] + (i & 1);

/** The top `count` ranks of `bits`, packed four bits each. */
function top(bits, count) {
  let code = 0;
  for (let i = 0; i < count; i++) {
    code <<= 4;
    if (bits) {
      const h = highest(bits);
      code |= h;
      bits &= ~(1 << h);
    }
  }
  return code;
}

export function evaluateMask(lo, hi) {
  const s0 = lo & 0x1FFF, s1 = (lo >>> 16) & 0x1FFF, s2 = hi & 0x1FFF, s3 = (hi >>> 16) & 0x1FFF;
  // A flush can't share 7 cards with quads or a full house, so it's safe to check first.
  for (const set of [s0, s1, s2, s3]) {
    if (POP[set] >= 5) {
      const straight = STRAIGHTS[set];
      if (straight) return (8 << 20) | ((straight - 1) << 16);
      return (5 << 20) | top(set, 5);
    }
  }
  // How many of each rank, as bit planes.
  let p0 = 0, p1 = 0, p2 = 0;
  for (const x of [s0, s1, s2, s3]) {
    const c0 = p0 & x; p0 ^= x;
    const c1 = p1 & c0; p1 ^= c0;
    p2 |= c1;
  }
  const any = s0 | s1 | s2 | s3;
  const threes = p0 & p1, twos = p1 & ~p0;
  if (p2) {
    const q = highest(p2);
    return (7 << 20) | (q << 16) | (top(any & ~(1 << q), 1) << 12);
  }
  if (threes) {
    const t = highest(threes);
    const rest = (threes & ~(1 << t)) | twos;
    if (rest) return (6 << 20) | (t << 16) | (highest(rest) << 12);
  }
  const straight = STRAIGHTS[any];
  if (straight) return (4 << 20) | ((straight - 1) << 16);
  if (threes) {
    const t = highest(threes);
    return (3 << 20) | (t << 16) | (top(any & ~(1 << t), 2) << 8);
  }
  if (twos) {
    const a = highest(twos), others = twos & ~(1 << a);
    if (others) {
      const b = highest(others);
      return (2 << 20) | (a << 16) | (b << 12) | (top(any & ~(1 << a) & ~(1 << b), 1) << 8);
    }
    return (1 << 20) | (a << 16) | (top(any & ~(1 << a), 3) << 4);
  }
  return top(any, 5);
}

export function evaluate(cards) {
  const m = maskOf(cards);
  return evaluateMask(m.lo, m.hi);
}

export const category = (score) => score >> 20;
const slotRank = (score, slot) => ((score >> (16 - 4 * slot)) & 0xF) + 2;

/** "Two Pair, Kings and Sevens", "Flush, Ace High", "Royal Flush". */
export function handName(score) {
  const r0 = slotRank(score, 0), r1 = slotRank(score, 1);
  switch (category(score)) {
    case HIGH_CARD: return `${rankName(r0)} High`;
    case PAIR: return `Pair of ${rankPlural(r0)}`;
    case TWO_PAIR: return `Two Pair, ${rankPlural(r0)} and ${rankPlural(r1)}`;
    case TRIPS: return `Three ${rankPlural(r0)}`;
    case STRAIGHT: return `Straight, ${rankName(r0)} High`;
    case FLUSH: return `Flush, ${rankName(r0)} High`;
    case FULL_HOUSE: return `Full House, ${rankPlural(r0)} Full of ${rankPlural(r1)}`;
    case QUADS: return `Four ${rankPlural(r0)}`;
    default: return r0 === 14 ? 'Royal Flush' : `Straight Flush, ${rankName(r0)} High`;
  }
}

/** The five cards that make the hand, for lighting up at a showdown. */
export function bestFive(cards) {
  if (cards.length <= 5) return cards.slice();
  let best = [], bestScore = -1;
  const drop = cards.length - 5;          // 1 or 2 cards left out.
  for (let a = 0; a < cards.length; a++) {
    for (let b = drop === 2 ? a + 1 : a; b < cards.length; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      if (five.length !== 5) continue;
      const s = evaluate(five);
      if (s > bestScore) { bestScore = s; best = five; }
    }
  }
  return best;
}

export { rankOf };
