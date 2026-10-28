// Starting-hand strength (the app's `Preflop`): the 169 kinds of starting hand, best first,
// ranked by average all-in equity against one and against three random hands.

import { maskOf, rankOf, suitOf } from './cards.js';

export const ORDER = ["AA", "KK", "QQ", "JJ", "TT", "99", "AKs", "88", "AQs", "AJs", "AKo", "ATs", "KQs", "AQo", "77", "KJs", "AJo", "A9s", "KTs", "KQo", "ATo", "QJs", "A8s", "66", "KJo", "QTs", "A7s", "K9s", "KTo", "A9o", "A5s", "JTs", "A6s", "QJo", "A4s", "A8o", "Q9s", "55", "K8s", "A3s", "QTo", "A7o", "K9o", "K7s", "J9s", "A2s", "Q8s", "JTo", "A5o", "K6s", "A6o", "T9s", "K5s", "Q9o", "A4o", "K8o", "44", "J8s", "K4s", "A3o", "Q7s", "K7o", "J9o", "K3s", "T8s", "A2o", "Q6s", "Q8o", "J7s", "K6o", "K2s", "T9o", "Q5s", "98s", "K5o", "33", "Q4s", "T7s", "J8o", "K4o", "Q7o", "Q3s", "97s", "J6s", "T8o", "J5s", "87s", "Q2s", "Q6o", "K3o", "T6s", "J4s", "98o", "J7o", "22", "Q5o", "K2o", "96s", "T7o", "J3s", "86s", "Q4o", "76s", "T5s", "J2s", "97o", "J6o", "T4s", "Q3o", "95s", "87o", "T3s", "J5o", "85s", "Q2o", "T6o", "65s", "75s", "T2s", "J4o", "96o", "94s", "J3o", "86o", "84s", "93s", "54s", "76o", "74s", "T5o", "64s", "J2o", "T4o", "92s", "95o", "53s", "83s", "T3o", "85o", "73s", "63s", "75o", "82s", "65o", "43s", "T2o", "94o", "52s", "84o", "93o", "54o", "62s", "72s", "74o", "64o", "42s", "92o", "32s", "53o", "83o", "63o", "73o", "82o", "43o", "52o", "62o", "72o", "42o", "32o"];

const letter = (r) => (r === 10 ? 'T' : ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r)));

/** "AKs", "T9o", "77". */
export function handLabel(a, b) {
  const high = Math.max(rankOf(a), rankOf(b)), low = Math.min(rankOf(a), rankOf(b));
  if (high === low) return letter(high) + letter(low);
  return letter(high) + letter(low) + (suitOf(a) === suitOf(b) ? 's' : 'o');
}

const CLASS_PERCENTILE = (() => {
  const result = {};
  let before = 0;
  for (const name of ORDER) {
    const combos = name.length === 2 ? 6 : name.endsWith('s') ? 4 : 12;
    result[name] = (before + combos / 2) / 1326;
    before += combos;
  }
  return result;
})();

/** 0 for aces, about 1 for 3-2 offsuit: the share of starting hands better than this one. */
export const percentile = (a, b) => CLASS_PERCENTILE[handLabel(a, b)];

/** All 1,326 starting hands, best first: { a, b, lo, hi, percentile }. */
export const COMBOS = (() => {
  const list = [];
  for (let i = 0; i < 52; i++) {
    for (let j = i + 1; j < 52; j++) {
      const m = maskOf([i, j]);
      list.push({ a: i, b: j, lo: m.lo, hi: m.hi, percentile: percentile(i, j) });
    }
  }
  // Swift's sort isn't stable either way; ties keep card order here.
  return list.sort((x, y) => x.percentile - y.percentile);
})();
