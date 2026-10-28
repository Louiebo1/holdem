// Statistics for one player (Louie, 2026-10-28: "make the statistics informative… do all"):
// tournament results, playing style, memorable hands, starting hands and rivals. A "line" is
// one set of numbers (vs the computer, or with friends). Plain JSON, so it can follow the
// Google sign-in (account.js). Firebase drops empty objects, so `normalize` fills the
// missing parts back in. The same functions record the bots in tests/styles.js, which is
// where STYLE_PROFILES below come from.

import * as G from './game.js';
import { evaluate, category, bestFive, STRAIGHT_FLUSH } from './evaluator.js';
import { handLabel } from './preflop.js';
import { rankOf } from './cards.js';

export const blankLine = () => ({
  // The original lines.
  played: 0, won: 0, podium: 0, placeSum: 0, hands: 0, handsWon: 0, showdownsWon: 0, biggestPot: 0, knockouts: 0,
  // Results: finishes by place (p1, p2, …) at six and nine seats, the last ten, win streaks.
  finishes: { six: {}, nine: {} }, recent: [], streak: 0, bestStreak: 0,
  // Style (each hand dealt in): played a hand, raised before the flop, saw the flop, bets and
  // raises / calls after the flop, went to a showdown, won it.
  style: { dealt: 0, vpip: 0, pfr: 0, sawFlop: 0, aggr: 0, calls: 0, wtsd: 0, wsd: 0 },
  // Hands made by the river (c1 pair … c8 straight flush, royal), the best one, all-ins.
  made: {}, bestHand: null,
  allIns: { won: 0, lost: 0, badBeats: 0, lucky: 0 }, worstBeat: null, luckiest: null,
  // Starting hands by kind ("AKs", "QQ", "72o"): dealt, won, net in big blinds.
  starts: {},
  // Who knocked me out, and whom I knocked out: by bot style, or "friend".
  rivals: { outBy: {}, outed: {} },
});

/** Fill in whatever is missing (old saved stats, or parts Firebase dropped). */
export function normalize(line) {
  const fill = (blank, have) => {
    if (have === undefined || have === null) return blank;
    if (!blank || typeof blank !== 'object' || Array.isArray(blank)) return have;
    const out = { ...have };
    for (const k of Object.keys(blank)) out[k] = fill(blank[k], have[k]);
    return out;
  };
  const out = fill(blankLine(), line || {});
  if (!Array.isArray(out.recent)) out.recent = Object.values(out.recent || {});
  return out;
}

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

/** My chance of winning when the chips went in (the board as it was then; every hand is
 *  face up): ties count as a share. Exact with two cards or fewer to come, else sampled. */
export function allInEquity(g, me, rng = Math.random) {
  const from = g.runoutFrom ?? g.board.length;
  const known = g.board.slice(0, from);
  const players = G.liveSeats(g);
  const used = new Set([...players.flatMap((s) => g.seats[s].hole), ...known]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const need = 5 - known.length;
  let total = 0, n = 0;
  const score = (board) => {
    const mine = evaluate([...g.seats[me].hole, ...board]);
    let best = -1, ties = 0;
    for (const s of players) {
      if (s === me) continue;
      const v = evaluate([...g.seats[s].hole, ...board]);
      if (v > best) { best = v; ties = 0; }
      if (v === best) ties++;
    }
    total += mine > best ? 1 : mine === best ? 1 / (ties + 1) : 0;
    n++;
  };
  if (need === 0) score(known);
  else if (need === 1) for (const a of deck) score([...known, a]);
  else if (need === 2) for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) score([...known, deck[i], deck[j]]);
  else {
    const rand = typeof rng === 'function' ? rng : () => rng.unit();
    for (let t = 0; t < 3000; t++) {
      const d = deck.slice(), extra = [];
      for (let k = 0; k < need; k++) extra.push(d.splice(Math.floor(rand() * d.length), 1)[0]);
      score([...known, ...extra]);
    }
  }
  return n ? total / n : 0;
}

/** One finished hand, for the player in `me`. `now` is the date to remember it by. */
export function recordHand(line, g, me, now = Date.now(), rng = Math.random) {
  const seat = g.seats[me], r = g.result;
  if (!seat.inHand || !r) return;
  const won = r.won[me] || 0, net = won - seat.committed;
  const bb = G.bigBlind(g);
  const mine = g.actions.filter((a) => a.seat === me);
  const live = !seat.folded;

  // The original lines.
  line.hands += 1;
  if (net > 0) { line.handsWon += 1; if (r.showdown) line.showdownsWon += 1; }
  line.biggestPot = Math.max(line.biggestPot, won);
  if (won > 0) line.knockouts += r.busted.filter((s) => s !== me).length;

  // Style.
  const st = line.style;
  st.dealt += 1;
  const pre = mine.filter((a) => a.street === G.PREFLOP);
  if (pre.some((a) => a.kind === 'call' || a.kind === 'raise' || a.kind === 'bet')) st.vpip += 1;
  if (pre.some((a) => a.kind === 'raise' || a.kind === 'bet')) st.pfr += 1;
  const sawFlop = g.board.length >= 3 && (live || mine.some((a) => a.street >= G.FLOP));
  if (sawFlop) st.sawFlop += 1;
  for (const a of mine) {
    if (a.street === G.PREFLOP) continue;
    if (a.kind === 'bet' || a.kind === 'raise') st.aggr += 1;
    else if (a.kind === 'call') st.calls += 1;
  }
  const showed = r.showdown && r.shown.includes(me);
  if (showed) { st.wtsd += 1; if (won > 0) st.wsd += 1; }

  // Starting hand.
  const label = handLabel(seat.hole[0], seat.hole[1]);
  const sh = line.starts[label] || (line.starts[label] = { n: 0, w: 0, bb: 0 });
  sh.n += 1;
  if (net > 0) sh.w += 1;
  sh.bb = Math.round((sh.bb + net / bb) * 10) / 10;

  // Hands made by the river, and the best one.
  if (live && g.board.length === 5) {
    const cards = [...seat.hole, ...g.board];
    const score = evaluate(cards);
    const cat = category(score);
    const five = bestFive(cards);
    const royal = cat === STRAIGHT_FLUSH && Math.max(...five.map(rankOf)) === 14 && Math.min(...five.map(rankOf)) === 10;
    if (cat >= 1) bump(line.made, royal ? 'royal' : 'c' + cat);
    if (!line.bestHand || score > line.bestHand.rank) line.bestHand = { rank: score, cards: five, hole: seat.hole.slice(), date: now };
  }

  // All-ins: I was in at a showdown where someone's chips were all in.
  const allIn = live && r.showdown && g.actions.some((a) => a.allIn && !g.seats[a.seat].folded);
  if (allIn) {
    if (won > 0) line.allIns.won += 1; else line.allIns.lost += 1;
    // Cards still to come when the chips went in: was I ahead (a bad beat) or behind (lucky)?
    if (g.runoutFrom !== null && g.runoutFrom !== undefined && g.runoutFrom < 5) {
      const eq = allInEquity(g, me, rng);
      const opponents = G.liveSeats(g).filter((s) => s !== me).map((s) => g.seats[s].hole.slice());
      const memo = { hole: seat.hole.slice(), them: opponents, board: g.board.slice(), from: g.runoutFrom, date: now };
      if (won === 0 && eq >= 0.6) {
        line.allIns.badBeats += 1;
        if (!line.worstBeat || eq > line.worstBeat.rank) line.worstBeat = { rank: Math.round(eq * 1000) / 1000, ...memo };
      } else if (won > 0 && net > 0 && eq <= 0.4) {
        line.allIns.lucky += 1;
        if (!line.luckiest || 1 - eq > line.luckiest.rank) line.luckiest = { rank: Math.round((1 - eq) * 1000) / 1000, ...memo };
      }
    }
  }
}

/** My tournament is over: `place` of `players`. */
export function recordFinish(line, place, players, now = Date.now()) {
  line.played += 1; line.placeSum += place;
  if (place === 1) line.won += 1; else if (place <= 3) line.podium += 1;
  bump(line.finishes[players > 6 ? 'nine' : 'six'], 'p' + place);
  line.streak = place === 1 ? line.streak + 1 : 0;
  line.bestStreak = Math.max(line.bestStreak, line.streak);
  line.recent = [{ place, of: players, date: now }, ...(line.recent || [])].slice(0, 10);
}

/** The whole tournament is over (so the bots' styles can be known): who knocked me out,
 *  and whom I knocked out. `rivalOf(seat)` → a style name, or "friend". */
export function recordRivals(line, g, me, rivalOf) {
  const by = g.knockedOutBy || {};
  for (const [s, k] of Object.entries(by)) {
    const out = Number(s);
    if (k === null || k === undefined) continue;
    if (out === me && k !== me) bump(line.rivals.outBy, rivalOf(k));
    else if (k === me && out !== me) bump(line.rivals.outed, rivalOf(out));
  }
}

// MARK: Reading the numbers

const pct = (part, whole) => (whole ? part / whole : null);

/** The style numbers, or null before there are enough hands to say. */
export function styleNumbers(line, minHands = 30) {
  const st = line.style;
  if (st.dealt < minHands) return null;
  return {
    vpip: pct(st.vpip, st.dealt), pfr: pct(st.pfr, st.dealt),
    aggression: st.calls ? st.aggr / st.calls : st.aggr ? 4 : 0,
    wtsd: pct(st.wtsd, st.sawFlop), wsd: pct(st.wsd, st.wtsd),
  };
}

/** Each bot style's numbers, measured with tests/styles.js (2026-10-28: the average of 600
 *  six-player and 300 nine-player tournaments of the real bots — tournament numbers run
 *  looser than full-table cash games, since the late hands are short-handed). */
export const STYLE_PROFILES = {
  rock: { vpip: 0.232, pfr: 0.176, aggression: 1.92, wtsd: 0.538 },
  shark: { vpip: 0.324, pfr: 0.259, aggression: 2.76, wtsd: 0.487 },
  trapper: { vpip: 0.287, pfr: 0.188, aggression: 1.26, wtsd: 0.485 },
  grinder: { vpip: 0.273, pfr: 0.201, aggression: 1.99, wtsd: 0.507 },
  bully: { vpip: 0.293, pfr: 0.232, aggression: 2.50, wtsd: 0.514 },
  reader: { vpip: 0.297, pfr: 0.226, aggression: 1.92, wtsd: 0.509 },
};

// How big a difference in each number counts as "plays differently".
const SCALE = { vpip: 0.06, pfr: 0.05, aggression: 0.5, wtsd: 0.12 };

/** The bot style closest to how this player plays (null before enough hands). */
export function closestStyle(line) {
  const me = styleNumbers(line);
  if (!me || me.wtsd === null) return null;
  const names = Object.keys(STYLE_PROFILES);
  let best = null, bestD = Infinity;
  for (const n of names) {
    const p = STYLE_PROFILES[n];
    const d = ['vpip', 'pfr', 'aggression', 'wtsd'].reduce((t, k) => t + ((Math.min(me[k], k === 'aggression' ? 5 : 1) - p[k]) / SCALE[k]) ** 2, 0);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}
