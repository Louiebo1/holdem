// Cards as ints 0…51, the app's `Card.index`: suit * 13 + rank − 2 (ranks 2…14, ace 14;
// suits ♣0 ♦1 ♥2 ♠3). A set of cards is a mask in two 32-bit halves, like the app's 64-bit
// `Card.mask`: lo = ♣ | ♦ << 16, hi = ♥ | ♠ << 16, 13 rank bits per suit.

export const CLUBS = 0, DIAMONDS = 1, HEARTS = 2, SPADES = 3;
export const SUITS = [CLUBS, DIAMONDS, HEARTS, SPADES];
export const SYMBOL = ['♣', '♦', '♥', '♠'];
export const SUIT_NAME = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];
export const isRedSuit = (s) => s === DIAMONDS || s === HEARTS;

export const card = (suit, rank) => suit * 13 + rank - 2;
export const suitOf = (c) => Math.floor(c / 13);
export const rankOf = (c) => (c % 13) + 2;
export const FULL_DECK = Array.from({ length: 52 }, (_, i) => i);

export const rankLabel = (r) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r));
const RANK_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
export const rankName = (r) => RANK_NAMES[r - 2];
export const rankPlural = (r) => (r === 6 ? 'Sixes' : rankName(r) + 's');
export const label = (c) => rankLabel(rankOf(c)) + SYMBOL[suitOf(c)];

/** The card's bit, as [half, bit]: half 0 = lo (♣ ♦), 1 = hi (♥ ♠). */
export const bitOf = (c) => {
  const s = suitOf(c);
  return [s >> 1, 1 << (((s & 1) * 16) + rankOf(c) - 2)];
};

/** A mask { lo, hi } of these cards. */
export function maskOf(cards) {
  let lo = 0, hi = 0;
  for (const c of cards) {
    const [half, bit] = bitOf(c);
    if (half) hi |= bit; else lo |= bit;
  }
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

/** Swift's random numbers, or Math.random: { below(n), unit() }. */
export const mathRandom = {
  below: (n) => Math.floor(Math.random() * n),
  unit: () => Math.random(),
};

/** A seeded generator (tests and the bench replay the same games). */
export function seeded(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { below: (n) => Math.floor(next() * n), unit: next };
}

export function shuffled(list, rng = mathRandom) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
