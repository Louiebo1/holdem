// Learn mode (Louie, 2026-10-30): a coach that teaches as much as possible, always on screen,
// only in games against the computer. It sees only what the player can see (`playerView`):
// their own cards and what's public. Everything here is worked out the same way the app's
// Coach.swift does it, so the two say the same things.
//
// Text uses **bold** markers; the screens turn them into bold type.

import { rankOf, suitOf, rankName, rankPlural, label, SYMBOL, maskOf } from './cards.js';
import { evaluate, evaluateMask, category, handName, CATEGORY, HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE } from './evaluator.js';
import { percentile, handLabel } from './preflop.js';
import { Bot, playerView, pushRange, openRange, handClass, DRAW, STYLES } from './bot.js';
import * as G from './game.js';

const defaultRng = { below: (n) => Math.floor(Math.random() * n), unit: () => Math.random() };
const fmt = (n) => Number(n).toLocaleString('en-US');
const pct = (x) => `${Math.round(x * 100)}%`;
const top = (p) => (p > 0.5 ? `bottom ${Math.max(1, Math.round((1 - p) * 100))}%` : `top ${Math.max(1, Math.round(p * 100))}%`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const PUSH_FOLD_BB = STYLES.grinder.params.pushFoldBB;

// MARK: Seats

/** Where a seat sits this hand: Button, Small Blind, Big Blind, Under the Gun, Middle, Hijack, Cutoff. */
export function seatPosition(g, seat) {
  const n = g.seats.length, order = [];
  for (let k = 0; k < n; k++) {
    const c = (g.button + k) % n;
    if (g.seats[c].inHand) order.push(c);
  }
  const i = order.indexOf(seat), count = order.length;
  let name, blurb, late = false;
  if (count === 2) {
    if (i === 0) { name = 'the Button (small blind)'; blurb = 'Heads-up, you act first before the flop and last after it. Play lots of hands — most of them by raising.'; late = true; }
    else { name = 'the Big Blind'; blurb = 'Heads-up, you defend your blind with most hands: you already have a full bet in.'; }
  } else if (i === 0) { name = 'the Button'; blurb = 'The best seat: after the flop you act last on every round, so you see what everyone does first. You can play more hands here.'; late = true; }
  else if (i === 1) { name = 'the Small Blind'; blurb = 'You have half a bet in already, but after the flop you act first every round — a tough seat. Don\'t play too many hands from here.'; }
  else if (i === 2) { name = 'the Big Blind'; blurb = 'You already have a full bet in, so calling a raise costs less: you can defend with more hands. After the flop you act early.'; }
  else if (i === count - 1) { name = 'the Cutoff'; blurb = 'Only the button acts after you: a good seat to raise and steal the blinds.'; late = true; }
  else if (i === count - 2 && count >= 5) { name = 'the Hijack'; blurb = 'Fairly late: a few players still to come, so play good hands and some steals.'; late = true; }
  else if (i === 3) { name = 'Under the Gun'; blurb = 'You act first before the flop with everyone still to come. Play only strong hands from here.'; }
  else { name = 'Middle Position'; blurb = 'Several players still act after you: play solid hands, not marginal ones.'; }
  // Players who act after this seat before the flop (for how wide a raise from here is):
  // the order is Under the Gun … Cutoff, then the Button, Small Blind, Big Blind.
  const behind = count === 2 ? (i === 0 ? 1 : 0) : i <= 2 ? 2 - i : count - 1 - i + 3;
  return { name, blurb, late, index: i, count, behind };
}

const opponentsOf = (v) => v.live.map((l, i) => (l && i !== v.me ? i : -1)).filter((i) => i >= 0);
const stackOf = (v, s) => v.chips[s] + v.bets[s];
function actsLast(v) {
  const distance = (s) => (s - v.button - 1 + v.playerCount) % v.playerCount;
  return opponentsOf(v).every((s) => distance(s) < distance(v.me));
}

// MARK: Starting hands

export function startingName(a, b) {
  const hi = Math.max(rankOf(a), rankOf(b)), lo = Math.min(rankOf(a), rankOf(b));
  if (hi === lo) return `a pair of ${rankPlural(hi)}`;
  return `${rankName(hi)}-${rankName(lo)} ${suitOf(a) === suitOf(b) ? 'suited' : 'offsuit'}`;
}

function startingTier(p) {
  if (p <= 0.03) return 'a premium hand, one of the very best';
  if (p <= 0.08) return 'a strong hand';
  if (p <= 0.2) return 'a good hand';
  if (p <= 0.35) return 'a playable hand in the right spot';
  if (p <= 0.6) return 'a weak hand';
  return 'one of the weakest hands — usually a fold';
}

function startingTips(a, b) {
  const hi = Math.max(rankOf(a), rankOf(b)), lo = Math.min(rankOf(a), rankOf(b)), suited = suitOf(a) === suitOf(b);
  const tips = [];
  if (hi === lo) {
    if (hi >= 11) tips.push('A big pair is often the best hand even if nothing else comes. Raise it.');
    else tips.push('A small or medium pair mostly hopes to make three of a kind on the flop — about **1 time in 8 (12%)**. Cheap calls are fine when stacks are deep; don\'t pay a lot to see the flop.');
  } else {
    if (suited) tips.push('Suited cards make a flush about **6%** of the time by the river — a small bonus, not a reason to play a weak hand.');
    if (hi - lo <= 2 && lo >= 4 && lo < 10) tips.push('Connected cards can make straights, so they play well in big pots when the stacks are deep.');
    if (hi === 14 && lo <= 9 && !suited) tips.push('Ace with a small card: when you pair the ace, a better ace (a bigger "kicker") often beats you.');
    if (hi >= 10 && lo >= 10) tips.push('Two high cards: pairing either one usually gives you top pair.');
  }
  return tips;
}

// MARK: Made hands, the board, and outs

const slotRank = (score, slot) => ((score >> (16 - 4 * slot)) & 0xF) + 2;

/** What I have, in words a learner can use: "Top pair, good kicker". */
export function describeMade(hole, board) {
  const score = evaluate([...hole, ...board]), bScore = evaluate(board);
  const cat = category(score), bCat = category(bScore);
  const name = handName(score);
  const ranks = [...new Set(board.map(rankOf))].sort((x, y) => y - x);
  const topCard = ranks[0];
  const [h1, h2] = hole.map(rankOf).sort((x, y) => y - x);
  const pocket = h1 === h2;

  if (cat === bCat) {
    if (cat === HIGH_CARD) {
      const overs = hole.filter((c) => rankOf(c) > topCard).length;
      return { title: `No pair — ${name}`, text: overs === 2 ? 'Both your cards are higher than the board ("two overcards"): you have six cards that pair you up.' : 'Nothing yet. Without a pair, this hand rarely wins if there\'s betting.' };
    }
    if (score === bScore) return { title: `${name} — on the board`, text: 'The board makes this hand by itself, so everyone still in has it too. You\'re playing the board: at best you split the pot.' };
    if (cat === PAIR) return { title: `${name} — on the board`, text: 'The pair is on the board, so everyone has it. Only your high cards help.' };
    return { title: name, text: 'Most of this hand is on the board for everyone; your cards improve it a little.' };
  }
  switch (cat) {
    case PAIR: {
      const r = slotRank(score, 0);
      if (pocket) {
        if (r > topCard) return { title: `Overpair — ${name}`, text: 'Your pocket pair is higher than every card on the board. Strong — bet it — but be careful when there\'s a lot of betting.' };
        const higher = ranks.filter((x) => x > r).length;
        return { title: `Underpair — ${name}`, text: `Your pair is lower than ${plural(higher, 'card')} on the board: anyone holding one of those beats you.` };
      }
      const kicker = h1 === r ? h2 : h1;
      if (r === topCard) {
        const k = kicker === 14 || (kicker === 13 && r === 14) ? 'top kicker' : kicker >= 11 ? 'good kicker' : 'weak kicker';
        return { title: `Top pair, ${k} — ${name}`, text: `You paired the highest card on the board${k === 'weak kicker' ? `, but your other card (${rankName(kicker)}) is low: someone with the same pair and a bigger card beats you` : ''}. Top pair is usually worth betting when few players are in.` };
      }
      if (r === ranks[1]) return { title: `Second pair — ${name}`, text: 'A medium hand: fine to check and call small bets, but anyone who paired the top card beats you.' };
      return { title: `Bottom pair — ${name}`, text: 'A weak pair: any higher pair beats you. Don\'t put many chips in with it.' };
    }
    case TWO_PAIR: {
      if (bCat === PAIR) {
        const boardPair = slotRank(bScore, 0);
        const mine = slotRank(score, 0) === boardPair ? slotRank(score, 1) : slotRank(score, 0);
        return { title: `${name} — really one pair`, text: `One of the pairs is on the board for everyone, so what you really have is a pair of ${rankPlural(mine)}${mine > topCard ? ', bigger than any board card' : ''}.` };
      }
      if (bCat === HIGH_CARD) return { title: `Two pair — ${name}`, text: 'Both your cards paired the board: a strong hand. Bet it, and watch out for straight and flush cards.' };
      return { title: name, text: 'The board has two pair; your pair counts instead of its lower one.' };
    }
    case TRIPS:
      if (pocket) return { title: `A set — ${name}`, text: 'Three of a kind with your pocket pair: very strong and well hidden. Others rarely see it coming, so build the pot.' };
      return { title: `Trips — ${name}`, text: 'The pair on the board plus one of your cards. Strong, but someone with the same card and a bigger kicker beats you.' };
    case STRAIGHT:
      return { title: name, text: 'A straight: strong. Watch for a possible flush (three cards of one suit on the board) or a paired board (full house).' };
    case FLUSH: {
      const all = [...hole, ...board];
      const suit = [0, 1, 2, 3].find((s) => all.filter((c) => suitOf(c) === s).length >= 5);
      const mine = hole.filter((c) => suitOf(c) === suit).map(rankOf);
      const best = Math.max(...mine);
      const used = new Set(all.filter((c) => suitOf(c) === suit).map(rankOf));
      let nuts = true;
      for (let r = best + 1; r <= 14; r++) if (!used.has(r)) nuts = false;
      return { title: name, text: nuts ? 'The **nut flush** — no bigger flush is possible. Very strong.' : 'A flush: very strong, but a bigger flush is possible if they hold a higher card of that suit.' };
    }
    case FULL_HOUSE:
      return { title: name, text: 'A full house: a monster. Make sure you get paid — bet so worse hands call.' };
    default:
      return { title: name, text: 'A monster hand. Almost nothing beats it: bet so they call.' };
  }
}

/** What the board alone could make for someone (flushes, straights, full houses). */
export function boardWarnings(board, hole) {
  if (board.length < 3) return [];
  const lines = [];
  const mine = category(evaluate([...hole, ...board]));
  for (let s = 0; s < 4; s++) {
    const n = board.filter((c) => suitOf(c) === s).length;
    const sym = SYMBOL[s];
    if (n >= 3 && mine < FLUSH) lines.push(n >= 4 ? `Four ${sym} on the board: anyone with one ${sym} has a flush.` : `Three ${sym} on the board: anyone with two ${sym} has a flush.`);
    else if (n === 2 && board.length < 5) lines.push(`Two ${sym} on the board: someone could be drawing to a flush.`);
  }
  const ranks = new Set(board.map(rankOf));
  if (ranks.size < board.length && mine < FULL_HOUSE) lines.push('The board is paired: full houses and four of a kind are possible.');
  if (mine < STRAIGHT) {
    const has = (r) => ranks.has(r) || (r === 1 && ranks.has(14));
    for (let low = 1; low <= 10; low++) {
      let count = 0;
      for (let r = low; r < low + 5; r++) if (has(r)) count++;
      if (count >= 3) { lines.push(count >= 4 ? 'Four cards in a row on the board: one card makes a straight for someone.' : 'Three cards close together: two right cards make a straight.'); break; }
    }
  }
  return lines;
}

/** Cards that improve my hand (using my own cards), grouped by the hand they make. */
export function countOuts(hole, board) {
  if (board.length < 3 || board.length >= 5) return null;
  const known = new Set([...hole, ...board]);
  const now = category(evaluate([...hole, ...board]));
  const groups = {};
  let total = 0;
  for (let c = 0; c < 52; c++) {
    if (known.has(c)) continue;
    const next = [...board, c];
    const cat = category(evaluate([...hole, ...next]));
    if (cat > now && cat > category(evaluate(next))) { groups[cat] = (groups[cat] || 0) + 1; total += 1; }
  }
  const unseen = 52 - known.size;
  const nextCard = total / unseen;
  const byRiver = board.length === 3 ? 1 - ((unseen - total) * (unseen - total - 1)) / (unseen * (unseen - 1)) : nextCard;
  return { total, groups, unseen, nextCard, byRiver };
}

function outsLines(o, board) {
  if (!o || !o.total) return [];
  const kinds = Object.keys(o.groups).map(Number).sort((a, b) => b - a);
  const named = kinds.map((k) => `**${o.groups[k]}** make ${k === PAIR ? 'a pair' : k === TWO_PAIR ? 'two pair' : k === TRIPS ? 'three of a kind' : 'a ' + CATEGORY[k].toLowerCase()}`);
  const draws = [];
  if ((o.groups[FLUSH] || 0) >= 8) draws.push('a flush draw');
  if ((o.groups[STRAIGHT] || 0) >= 8) draws.push('an open-ended straight draw');
  else if ((o.groups[STRAIGHT] || 0) >= 3) draws.push('a gutshot (inside) straight draw');
  const lines = [];
  if (draws.length) lines.push(`You have ${draws.join(' and ')}.`);
  lines.push(`**${o.total} outs** (cards that improve you): ${named.join(', ')}.`);
  lines.push(board.length === 3
    ? `Chance to improve: **${pct(o.nextCard)}** on the turn, **${pct(o.byRiver)}** by the river. (Quick rule: outs × 4 on the flop, outs × 2 on the turn.)`
    : `Chance to improve on the river: **${pct(o.nextCard)}** (quick rule: outs × 2).`);
  if (kinds.every((k) => k <= TWO_PAIR)) lines.push('Pair and two-pair outs are weak: improving may still not be enough to win.');
  return lines;
}

// MARK: Equity

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

/** My share of the pot against random cards (to compare with their likely hands). */
function randomEquity(v, opponents, trials, rng) {
  if (!opponents) return 1;
  const mine = maskOf(v.hole), board = maskOf(v.board);
  let total = 0;
  for (let t = 0; t < trials; t++) {
    let usedLo = mine.lo | board.lo, usedHi = mine.hi | board.hi;
    const hands = [];
    for (let k = 0; k < opponents; k++) {
      const [lo, hi] = randomCards(2, usedLo, usedHi, rng);
      usedLo |= lo; usedHi |= hi; hands.push([lo, hi]);
    }
    const [rLo, rHi] = randomCards(5 - v.board.length, usedLo, usedHi, rng);
    const bLo = board.lo | rLo, bHi = board.hi | rHi;
    const me = evaluateMask(mine.lo | bLo, mine.hi | bHi);
    let ties = 1, lost = false;
    for (const [lo, hi] of hands) {
      const s = evaluateMask(lo | bLo, hi | bHi);
      if (s > me) { lost = true; break; }
      if (s === me) ties++;
    }
    if (!lost) total += 1 / ties;
  }
  return total / trials;
}

// MARK: Reading the other players

const KIND = { bet: 'bet', raise: 'raised', call: 'called', check: 'checked', fold: 'folded' };

/** What the other players' bets this hand usually mean. */
function readTable(g, v, seat, nameOf) {
  const lines = [];
  const bb = v.bigBlind;
  const streetActions = (st) => g.actions.filter((a) => a.street === st && a.seat !== seat && a.kind !== 'smallBlind' && a.kind !== 'bigBlind');
  const pre = streetActions(G.PREFLOP);
  const meaning = [];

  if (v.street === G.PREFLOP) {
    for (const a of pre) {
      const who = nameOf(a.seat);
      if (a.kind === 'raise' && a.raisesBefore === 1) {
        const pos = seatPosition(g, a.seat);
        const bbs = a.amount / bb;
        if (a.allIn && bbs < 15) meaning.push(`**${who} went all in** for ${fmt(a.amount)} (${bbs.toFixed(0)} big blinds). Short stacks push with lots of hands — about the ${top(pushRange(bbs, pos.behind))} from that seat — so don't assume a monster.`);
        else meaning.push(`**${who} raised** to ${fmt(a.amount)} from ${pos.name}. Good players raise about the ${top(openRange(pos.behind, v.playersLeft === 2))} of hands from there${pos.late ? ' — late seats raise lots of hands to steal the blinds' : ' — from an early seat a raise means a solid hand'}.`);
      } else if (a.kind === 'raise' && a.raisesBefore === 2) {
        meaning.push(`**${who} re-raised (a "3-bet")** to ${fmt(a.amount)}. That usually means a very strong hand — big pairs, ace-king, ace-queen — or now and then a bluff from a late seat.`);
      } else if (a.kind === 'raise') {
        meaning.push(`**${who} raised again (a "4-bet")** to ${fmt(a.amount)}. Almost always aces, kings, queens or ace-king.`);
      } else if (a.kind === 'call' && a.raisesBefore === 1) {
        meaning.push(`**${who} limped** (just called the big blind): usually a medium or speculative hand — small pairs, suited cards. Strong players mostly raise or fold instead.`);
      } else if (a.kind === 'call' && a.raisesBefore >= 2) {
        meaning.push(`**${who} called a raise**: a decent hand — medium pairs, good aces, suited high cards — but probably not the very best (those usually re-raise).`);
      }
    }
  } else {
    const aggressor = g.preflopAggressor;
    if (v.street === G.FLOP && aggressor !== null && aggressor !== seat && v.live[aggressor]) {
      meaning.push(`**${nameOf(aggressor)}** raised before the flop. The raiser often bets the flop whether they hit or not (a "continuation bet"), so a flop bet from them doesn't mean much on its own.`);
    }
    const now = streetActions(v.street);
    const startPot = G.pot(g) - g.seats.reduce((t, s) => t + s.bet, 0);
    for (const a of now) {
      const who = nameOf(a.seat);
      const checkedFirst = now.some((b) => b.seat === a.seat && b.kind === 'check' && g.actions.indexOf(b) < g.actions.indexOf(a));
      if (a.kind === 'bet') {
        const f = a.amount / Math.max(1, startPot);
        const size = a.allIn ? 'all in' : f < 0.4 ? 'a small bet (under half the pot)' : f <= 0.8 ? 'a normal-size bet (about half to most of the pot)' : 'a big bet (most of the pot or more)';
        const sense = a.allIn ? 'An all-in is usually a strong hand or a big draw; sometimes a short stack making a stand.'
          : f < 0.4 ? 'Small bets often come from medium hands, draws, or cheap bluffs.'
            : f <= 0.8 ? 'This could be a good hand, a draw or a bluff — look at the board and how they played before.'
              : 'Big bets are usually very strong hands or bluffs, rarely medium ones.';
        meaning.push(`**${who} bet** ${fmt(a.amount)}: ${size}. ${sense}${v.street === G.RIVER ? ' On the river no more cards come, so draws have either hit or missed.' : ''}`);
      } else if (a.kind === 'raise') {
        meaning.push(checkedFirst
          ? `**${who} check-raised** to ${fmt(a.amount)}: checked, then raised the bet. One of the strongest moves — usually a big hand, sometimes a bold draw.`
          : `**${who} raised** to ${fmt(a.amount)}. A raise after the flop usually means two pair or better, or a strong draw.`);
      } else if (a.kind === 'call') {
        meaning.push(`**${who} called** ${fmt(a.amount)}: usually a medium hand or a draw. When others have already called, your hand needs to be stronger to continue.`);
      }
    }
    if (!now.some((a) => a.kind === 'bet' || a.kind === 'raise') && now.length) {
      meaning.push(`Everyone so far has checked this round: that usually shows weakness (or a trap). A bet from you might win the pot.`);
    }
  }
  lines.push(...meaning.slice(-4));

  // What I've seen of the players who bet (public: anyone at the table could keep track).
  const watched = new Set([...pre, ...streetActions(v.street)].filter((a) => a.kind === 'bet' || a.kind === 'raise').map((a) => a.seat));
  for (const s of watched) {
    const t = g.tendencies[s];
    if (t.hands < 12) continue;
    const vpip = t.vpip / t.hands, pfr = t.pfr / t.hands;
    const loose = vpip > 0.36 ? 'plays lots of hands, so their bets can be weaker' : vpip < 0.18 ? 'plays few hands, so their bets mean more' : 'plays a normal number of hands';
    let line = `So far **${nameOf(s)}** has played ${pct(vpip)} of hands and raised first ${pct(pfr)} before the flop (typical: about 25% and 15%) — ${loose}.`;
    if (t.facedBet >= 5) line += ` Folds to a bet ${pct(t.foldedToBet / t.facedBet)} of the time.`;
    if (t.bluffsShown > 0) line += ` Caught bluffing ${plural(t.bluffsShown, 'time')}.`;
    lines.push(line);
  }
  return lines;
}

// MARK: The whole picture

/**
 * Everything to teach about this moment for the player in `seat`:
 *   { sections: [{ title, lines }], advice: { title, lines } | null, numbers }
 * `numbers` is what the hand review needs: { street, e, need, pct, advice }.
 */
export function coach(g, seat, nameOf = (s) => `Seat ${s + 1}`, rng = defaultRng) {
  const s = g.seats[seat];
  if (!s || !s.inHand || s.folded || s.out || s.hole.length !== 2 || g.phase === 'gameOver') return null;
  const v = playerView(g, seat);
  const bot = new Bot({ style: 'grinder' });
  const myTurn = g.phase === 'betting' && g.turn === seat;
  const opponents = opponentsOf(v);
  const n = opponents.length;
  const bb = v.bigBlind;
  const sections = [];

  // Your hand
  const p = percentile(v.hole[0], v.hole[1]);
  const hand = [];
  if (v.street === G.PREFLOP || v.board.length < 3) {
    hand.push(`**${label(v.hole[0])} ${label(v.hole[1])}** — ${startingName(v.hole[0], v.hole[1])} (${handLabel(v.hole[0], v.hole[1]).replace('T', '10')}). It's in the **${top(p)}** of starting hands: ${startingTier(p)}.`);
    hand.push(...startingTips(v.hole[0], v.hole[1]));
  } else {
    const made = describeMade(v.hole, v.board);
    hand.push(`**${made.title}.** ${made.text}`);
    hand.push(...outsLines(countOuts(v.hole, v.board), v.board));
    hand.push(...boardWarnings(v.board, v.hole));
  }
  sections.push({ title: 'Your hand', lines: hand });

  // Your chances
  const e = n ? bot.equity(v, 1500, rng) : 1;
  const er = n ? randomEquity(v, n, 1500, rng) : 1;
  const fair = 1 / (n + 1);
  const chances = [`You win about **${pct(e)}** of the time against the hands they're likely to have, judging by how they've bet.`];
  if (Math.abs(er - e) >= 0.06) chances.push(`Against random cards it would be ${pct(er)}. ${er > e ? 'Their betting says they probably hold better than random cards.' : 'Their play so far (checking, calling) suggests weaker hands than average.'}`);
  chances.push(`With ${plural(n + 1, 'player')} in the hand, an average hand wins about ${pct(fair)}. You're ${e > fair * 1.25 ? '**ahead** of that' : e < fair * 0.8 ? '**behind** that' : 'close to that'}.`);
  sections.push({ title: 'Your chances', lines: chances });

  // The math of calling, or betting
  const owe = Math.min(v.toCall, v.chips[seat]);
  const need = owe > 0 ? owe / (v.pot + owe) : null;
  const myClass = v.board.length >= 3 ? (() => { const hm = maskOf(v.hole), bm = maskOf(v.board); return handClass(hm.lo, hm.hi, v.board, bm.lo, bm.hi, evaluateMask(bm.lo, bm.hi)); })() : null;
  const math = [];
  if (owe > 0) {
    math.push(`To call costs **${fmt(owe)}** to win **${fmt(v.pot)}** (everything in the pot, bets included). The price: ${fmt(owe)} ÷ (${fmt(v.pot)} + ${fmt(owe)}) = **${pct(need)}**. You need to win at least that often for a call to pay off.`);
    math.push(e >= need ? `You win about ${pct(e)}, more than ${pct(need)}: calling **makes chips** over time.` : `You win about ${pct(e)}, less than ${pct(need)}: calling **loses chips** over time.`);
    if (v.street === G.PREFLOP && e >= need && owe < stackOf(v, seat) * 0.3) math.push('Before the flop the price is only part of the story: more betting comes later, and a weak hand often has to fold after the flop or acts first. That\'s why good players still fold many hands that look cheap here.');
    if (myClass === DRAW && v.street < G.RIVER) math.push('With a draw, the extra chips you can win when you hit (called "implied odds") make a call a little better than the bare numbers.');
    if (owe >= v.chips[seat]) math.push('Calling puts you all in: there\'s no more betting for you after this.');
  } else {
    math.push(`Nobody has bet this round, so checking is free.`);
    if (v.pot > 0) math.push(`Good bets are usually ½ to ¾ of the pot — here about **${fmt(Math.round(v.pot / 2))}–${fmt(Math.round(v.pot * 0.75))}**. Bet when worse hands will call (value), or when they'll likely fold (a bluff).`);
  }
  if (v.street > G.PREFLOP && v.pot > 0) {
    const spr = stackOf(v, seat) / v.pot;
    if (spr <= 2) math.push(`Your stack is only ${spr.toFixed(1)}× the pot: with a good hand, plan to get all your chips in.`);
  }
  sections.push({ title: owe > 0 ? 'The math of calling' : 'Betting', lines: math });

  // Position, and what good players do before the flop
  const pos = seatPosition(g, seat);
  const effBB = Math.min(stackOf(v, seat), Math.max(0, ...opponents.map((o) => stackOf(v, o)))) / bb;
  const raises = g.actions.filter((a) => a.street === G.PREFLOP && a.kind === 'raise').length;
  const limpers = g.actions.filter((a) => a.street === G.PREFLOP && a.kind === 'call').length;
  const headsUp = v.playersLeft === 2;
  const seatLines = [];
  let range = null;
  if (v.street === G.PREFLOP) {
    seatLines.push(`You're in **${pos.name}**. ${pos.blurb}`);
    if (raises === 0 && effBB <= PUSH_FOLD_BB) {
      range = pushRange(effBB, v.behind, headsUp) * (limpers ? 0.7 : 1);
      seatLines.push(`With only ${effBB.toFixed(0)} big blinds, good players **go all in or fold** — a small raise wastes chips. From here they push about the **${top(range)}** of hands. Yours (${top(p)}) is ${p <= range ? '**inside**' : '**outside**'} that.`);
    } else if (raises === 0) {
      range = openRange(v.behind, headsUp) * (limpers ? 0.75 : 1);
      if (v.toCall === 0) seatLines.push('Nobody raised and you\'re in the big blind: you can check for free and see the flop, or raise with a strong hand.');
      else seatLines.push(`Nobody has raised yet. With ${plural(v.behind, 'player')} still to act after you, good players **raise** about the **${top(range)}** of hands and fold the rest${limpers ? ' (a bit tighter when others have limped in)' : ''}. Yours (${top(p)}) is ${p <= range ? '**inside**' : '**outside**'} that range. Just calling ("limping") is usually weaker than raising.`);
    } else if (raises === 1) {
      const odds = owe / (v.pot + owe);
      range = Math.min(1, 0.16 * (actsLast(v) || v.behind === 0 ? 1.2 : 0.85) * (seat === v.bigBlindSeat ? 1.6 : 1) * (odds < 0.25 ? 1.25 : 1) * (effBB < 25 ? 0.8 : 1));
      seatLines.push(`Facing one raise, good players **re-raise** with about the top 5% (big pairs, ace-king) and **call** with about the **${top(range)}**${seat === v.bigBlindSeat ? ' — wider in the big blind because you already have a bet in' : ''}. Yours (${top(p)}) is ${p <= 0.05 ? 'a re-raise' : p <= range ? 'a call' : 'a fold'}.`);
    } else {
      range = 0.065;
      seatLines.push(`Facing a re-raise, only very strong hands continue: raise again with about the top 2–3% (aces, kings, queens, ace-king) and call with about the top 6%. Yours is ${top(p)}.`);
    }
    if (owe > 0 && owe >= stackOf(v, seat) * 0.3) seatLines.push('This is a big decision for your tournament: compare your chances with the price above.');
  } else {
    seatLines.push(actsLast(v)
      ? 'You act **last** this round ("in position"): you see what everyone does before you decide. That\'s an advantage — you can bet more often and control the pot.'
      : 'You act **before** someone this round ("out of position"): you have to decide without seeing what they do. Play a little more carefully.');
  }
  sections.push({ title: v.street === G.PREFLOP ? 'Your seat' : 'Position', lines: seatLines });

  // What they're telling you
  const reads = readTable(g, v, seat, nameOf);
  if (reads.length) sections.push({ title: 'What their bets mean', lines: reads });

  // Your stack
  const stack = stackOf(v, seat), myBB = stack / bb;
  const stackLines = [];
  const zone = myBB >= 40 ? 'Deep: you have room to play — small pairs and suited connectors can try to hit big hands.'
    : myBB >= 20 ? 'Medium: raise your good hands; don\'t call big re-raises without a strong hand.'
      : myBB > PUSH_FOLD_BB ? 'Getting short: if you raise and someone re-raises, you\'ll often have to go all in or fold. Look for a good hand to double up.'
        : 'Short: the "push or fold" zone. Before the flop, go all in with good hands and fold the rest — every blind you pay hurts.';
  stackLines.push(`You have **${fmt(stack)}** chips = **${myBB.toFixed(myBB < 10 ? 1 : 0)} big blinds**. ${zone}`);
  const left = G.playersLeft(g);
  const stacks = left.map((s2) => g.seats[s2].chips + g.seats[s2].bet + 0).sort((a, b) => b - a);
  const rank = stacks.indexOf(stack) + 1;
  const average = Math.round(left.reduce((t, s2) => t + g.seats[s2].chips + g.seats[s2].bet, 0) / left.length);
  stackLines.push(`You're ${rank === 1 ? '**the chip leader**' : `**${rank}${['th', 'st', 'nd', 'rd'][rank] || 'th'}** of ${left.length} in chips`} (average ${fmt(average)}).`);
  const up = G.handsUntilLevel(g), lvl = G.level(g);
  if (lvl + 1 < G.BLIND_LEVELS.length) {
    const next = G.BLIND_LEVELS[lvl + 1];
    stackLines.push(`Blinds go up in ${plural(up, 'hand')} to ${fmt(next / 2)} / ${fmt(next)}: then you'd have ${(stack / next).toFixed(0)} big blinds. Rising blinds mean you can't wait forever for great cards.`);
  }
  sections.push({ title: 'Your stack', lines: stackLines });

  // Advice: what a steady good player would do, and why
  let advice = null, move = null;
  if (myTurn) {
    move = bot.move(g, seat, rng);
    advice = explain(move, { g, v, e, need, p, range, raises, effBB, myClass, n, owe, seat });
  }
  const big = owe > 0 && (owe >= stack * 0.3 || opponents.some((o) => v.chips[o] === 0 && v.bets[o] > v.bets[seat]));
  return { sections, advice, numbers: { street: v.street, e, need, pct: p, range, big, advice: move, hand: g.handNumber } };
}

export function moveText(m, g, seat) {
  if (!m) return '';
  if (m.type === 'fold') return 'Fold';
  if (m.type === 'check') return 'Check';
  if (m.type === 'call') return `Call ${fmt(Math.min(G.toCall(g, seat), g.seats[seat].chips))}`;
  return m.to === G.maxRaiseTo(g, seat) ? 'All in' : `${g.currentBet === 0 ? 'Bet' : 'Raise to'} ${fmt(m.to)}`;
}

function explain(m, c) {
  const { g, v, e, need, p, range, raises, effBB, myClass, n, owe, seat } = c;
  const title = moveText(m, g, seat);
  const lines = [];
  const fair = 1 / (n + 1);
  const valueEquity = fair + (1 - fair) * 0.28 * (v.street === G.RIVER && n === 1 ? 0.8 : 1);
  const allIn = m.type === 'raise' && m.to === G.maxRaiseTo(g, seat);
  if (m.type === 'raise' && !allIn) {
    const by = m.to - v.bets[seat];
    lines.push(v.street !== G.PREFLOP ? `That's about ${Math.round((by / Math.max(1, v.pot)) * 100)}% of the pot.`
      : raises === 0 ? `That's ${(m.to / v.bigBlind).toFixed(1).replace('.0', '')} big blinds — a standard opening size.`
        : `That's about ${(m.to / Math.max(1, v.currentBet)).toFixed(1).replace('.0', '')} times their bet — a standard re-raise size.`);
  }
  const bigCall = owe > 0 && (owe >= stackOf(v, seat) * 0.3 || opponentsOf(v).some((o) => v.chips[o] === 0 && v.bets[o] > v.bets[seat]));
  if (v.street === G.PREFLOP && !bigCall) {
    if (m.type === 'fold') {
      lines.unshift(raises === 0 ? `Your hand (${top(p)}) is outside the range worth playing from this seat (${top(range)}). Folding weak hands early saves chips for better spots.`
        : `Against a raise your hand (${top(p)}) is too weak: good players continue with about the ${top(range)}.`);
    } else if (m.type === 'check') lines.unshift('You\'re in the big blind and nobody raised: see the flop for free.');
    else if (m.type === 'call') lines.unshift(raises === 0 ? 'It\'s cheap to see the flop with a playable hand.'
      : `Your hand is good enough to call a raise from here, but not strong enough to re-raise.${rankOf(v.hole[0]) === rankOf(v.hole[1]) ? ' A pair hopes to hit three of a kind on the flop.' : ''}`);
    else if (allIn && raises === 0 && effBB <= PUSH_FOLD_BB + 2) lines.unshift(`Push or fold: with ${effBB.toFixed(0)} big blinds, going all in makes everyone else risk their tournament to call. Your hand (${top(p)}) is in the pushing range.`);
    else if (raises === 0) lines.unshift(`Your hand (${top(p)}) is in the raising range from this seat (${top(range)}). Raising takes the lead: you can win the blinds right away or play the hand with the initiative.`);
    else lines.unshift(`Your hand (${top(p)}) is strong enough to re-raise: it builds the pot while you're likely ahead, and folds out weaker hands.`);
    return { title, lines };
  }
  const close = need !== null && Math.abs(e - need) < 0.04;
  if (m.type === 'fold') lines.unshift(owe === 0 ? 'Fold.' : close
    ? `It's close: you need **${pct(need)}** and win about **${pct(e)}** — roughly break-even. When it's that close, folding keeps your chips for a clearer spot.`
    : `You need **${pct(need)}** to call but win only about **${pct(e)}**. Folding saves chips.`);
  else if (m.type === 'call') lines.unshift(e >= need ? `You need ${pct(need)} and win about ${pct(e)}: calling makes chips over time.`
    : close ? `It's close: you need ${pct(need)} and win about ${pct(e)} — roughly break-even, so calling is fine${myClass === DRAW ? ', and with a draw you win extra chips when you hit' : ''}.`
      : `You need ${pct(need)} and win about ${pct(e)} now, but with a draw you'll win extra chips when you hit.`);
  else if (m.type === 'check') {
    if (e >= valueEquity) lines.unshift('Your hand is very strong: checking can set a trap — let them bet into you, then raise.');
    else if (e > fair) lines.unshift('Your hand has some value, but a bet would mostly get called by better hands and fold out worse ones. Check and keep the pot small.');
    else lines.unshift('Your hand is weak right now: check and see the next card for free.');
  } else if (owe === 0) {
    if (e >= valueEquity) lines.unshift(`**Value bet:** you're likely ahead (${pct(e)}). Bet so worse hands pay you, and so draws have to pay to chase.`);
    else if (v.preflopAggressor === seat && v.street === G.FLOP) lines.unshift('**Continuation bet:** you raised before the flop, so they expect a strong hand. A bet here often wins the pot right away.');
    else if (myClass === DRAW) lines.unshift('**Semi-bluff:** you have a draw. The bet can win the pot now, and if they call you can still hit.');
    else lines.unshift(`**Bluff:** they've shown weakness by checking, and your hand rarely wins a showdown (${pct(e)}). A bet is the only way to win this pot — bluff now and then, not all the time.`);
  } else {
    if (e >= valueEquity) lines.unshift(`**Raise for value:** you're well ahead of their likely hands (${pct(e)}). Make them pay to continue.`);
    else lines.unshift('**Semi-bluff raise:** you have a draw — they may fold now, and you can still hit if they call.');
  }
  if (bigCall && v.street === G.PREFLOP) lines.push(`Before the flop, all-in calls come down to the math: you need ${pct(need)} and have about ${pct(e)}.`);
  return { title, lines };
}

// MARK: After the hand

/**
 * How my decisions this hand went. `decisions`: [{ street, move, numbers }] in order.
 * Returns { lines, marks } — each decision gets ✓ (good), △ (fine, another move was better) or ✗.
 */
export function review(g, seat, decisions, nameOf = (s) => `Seat ${s + 1}`) {
  const lines = [];
  const r = g.result;
  if (!r) return null;
  const mine = g.seats[seat];
  const won = r.won[seat] || 0;
  const showHand = (s) => (g.board.length >= 3 ? handName(evaluate([...g.seats[s].hole, ...g.board])) : null);
  if (won > 0) lines.push(`**You won ${fmt(won)}**${r.showdown ? ` with ${showHand(seat)}` : ' — everyone else folded'}.`);
  else {
    const w = r.pots[0].winners[0];
    const theirs = r.showdown ? showHand(w) : null;
    lines.push(`**${nameOf(w)} won** ${fmt(r.pots[0].amount)}${theirs ? ` with ${theirs}` : ''}.`);
    if (mine.folded && g.board.length === 5 && r.showdown) {
      const me = evaluate([...mine.hole, ...g.board]);
      const best = Math.max(...r.shown.map((s) => evaluate([...g.seats[s].hole, ...g.board])));
      lines.push(me > best ? `If you'd stayed in, your ${handName(me)} would have won — but judge the decision by the odds when you made it, not by the cards that came later.`
        : `If you'd stayed in, your ${handName(me)} would have lost.`);
    } else if (!mine.folded && r.showdown) lines.push(`You had ${showHand(seat)}.`);
  }
  const STREETS = ['Before the flop', 'On the flop', 'On the turn', 'On the river'];
  let good = 0;
  for (const d of decisions) {
    const j = judge(d);
    if (j.mark === '✓') good += 1;
    lines.push(`${j.mark} ${STREETS[d.street]} you **${d.text}**${j.text ? ` — ${j.text}` : '.'}`);
  }
  if (decisions.length) lines.push(good === decisions.length ? 'Every decision matched good play. Results swing with the cards; good decisions win over time.'
    : 'Poker is about making the best decision with what you know. Over many hands, good decisions win chips even when a single hand goes wrong.');
  return lines;
}

const group = (m) => (m.type === 'fold' ? 'fold' : m.type === 'raise' ? 'raise' : 'passive');

function judge(d) {
  const n = d.numbers;
  if (!n || !n.advice) return { mark: '•', text: '' };
  const mine = group(d.move), best = group(n.advice);
  const adv = d.adviceText;
  const byRange = n.street === G.PREFLOP && !n.big && n.range !== null;
  const odds = byRange ? ` (your hand was ${top(n.pct)}; good players play about the ${top(n.range)} there)`
    : n.need !== null ? ` (you needed ${pct(n.need)} and had about ${pct(n.e)})` : '';
  if (mine === best) return { mark: '✓', text: `good, that's what a strong player does${byRange && (n.pct > n.range) !== (mine === 'fold') ? '' : odds}.` };
  if (mine === 'fold') {
    if (!byRange && n.need !== null && n.e > n.need + 0.03) return { mark: '✗', text: `folding gave up a profitable spot${odds}. Better: ${adv}.` };
    if (n.street === G.PREFLOP) return { mark: '✗', text: `this hand was strong enough to play${odds}. Better: ${adv}.` };
    return { mark: '△', text: `a careful fold; a strong player would ${adv.toLowerCase()} here.` };
  }
  if (best === 'fold') {
    if (!byRange && n.need !== null && n.e < n.need) return { mark: '✗', text: `that cost chips over time${odds}. Better: fold.` };
    if (n.street === G.PREFLOP) return { mark: '✗', text: `too weak to play there${odds}. Better: fold.` };
    return { mark: '△', text: 'risky — a strong player would fold here.' };
  }
  if (mine === 'raise') return { mark: '△', text: `aggressive. That works sometimes, but here a strong player would ${adv.toLowerCase()}${odds}.` };
  return { mark: '△', text: `a bet or raise was better (${adv}): ${n.e > 0.5 ? 'you were likely ahead, so make them pay' : 'it could win the pot right away'}.` };
}
