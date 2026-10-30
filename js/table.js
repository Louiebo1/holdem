// A Hold'em table: the game, who sits where (a person or a bot), and the pacing. The table's
// host runs the game: it applies everyone's moves, plays the bots, and deals each next hand
// (online, it publishes the state). Other players only send moves. Plain data throughout,
// so the same table runs locally or through Firebase.

import * as G from './game.js';
import { STYLE_NAMES } from './bot.js';
import { think } from './think.js';

/** Ordinary names for the bots, so they feel like people at the table (the app's). */
export const BOT_NAMES = ['Maggie', 'Ray', 'June', 'Walt', 'Dot', 'Frank', 'Ruth', 'Hank', 'Bea', 'Gus',
  'Ida', 'Earl', 'Pearl', 'Mac', 'Vera', 'Stan', 'Lou', 'Nell', 'Otis', 'Fay', 'Dan', 'Terry', 'Darlene', 'Sal', 'Rosie', 'Vic'];

/** The app's pacing (ms): a bot's move; a finished hand on show (a showdown longer); after an
 *  all-in the board comes out a street at a time; after every hand a person was dealt into, the
 *  next one waits for their Continue, up to a minute (Louie, 2026-10-28: folded or won). Faster once every person is out. */
export const PACE = { bot: 900, handPause: 2400, showdownPause: 4500, revealStart: 900, street: 1100, revealEnd: 600,
  continueWait: 60000, fastBot: 150, fastPause: 800 };

export const shuffledList = (list) => list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);

/** A fresh table: the game plus the seats ([{ kind: 'person' | 'bot', name }]). Each bot is
 *  dealt a secret style, picked independently (styles can repeat), revealed at the end. */
export function newTableState(seats) {
  const game = G.newGame(seats.length);
  game.humanSeats = peopleSeats({ seats });
  seats.forEach((s, i) => { if (s.kind === 'bot') game.botStyles[i] = STYLE_NAMES[Math.floor(Math.random() * STYLE_NAMES.length)]; });
  return { game, seats, paused: null, version: 0, continued: [], handEndedAt: null, continueDeadline: null, learn: false };
}

export const peopleSeats = (state) => state.seats.map((s, i) => (s.kind === 'person' ? i : -1)).filter((i) => i >= 0);

/** How long the board takes to come out after an all-in (the result waits for it). */
export function revealTime(g) {
  if (g.runoutFrom === null || g.runoutFrom === undefined || !g.result) return 0;
  const steps = [3, 4, 5].filter((n) => n > g.runoutFrom && n <= g.board.length).length;
  return steps ? PACE.revealStart + PACE.street * (steps - 1) + PACE.revealEnd : 0;
}

/** People who folded the hand just finished (and are still playing): the next hand waits
 *  for them to look at everyone's cards and tap Continue. */
export function waitingToContinue(state) {
  const g = state.game;
  if (g.phase !== 'handOver') return [];
  return peopleSeats(state).filter((s) => {
    const seat = g.seats[s];
    // Including the hand that knocked them out: they get to see it (Louie, 2026-10-28).
    const bustedNow = !!g.result && g.result.busted.includes(s);
    return seat.inHand && (!seat.out || bustedNow) && !state.continued.includes(s);
  });
}

/** Everyone who isn't a bot is out of the tournament: the bots play it out quickly. */
const onlyBotsLeft = (state) => peopleSeats(state).every((s) => state.game.seats[s].out);

/** Apply one move (from anyone) to the table state. Returns true if it changed. */
export function applyMove(state, move) {
  const g = state.game;
  try {
    switch (move.type) {
      case 'fold': case 'check': case 'call': case 'raise': {
        G.apply(g, move, move.seat);
        if (g.result) {
          state.handEndedAt = Date.now();
          state.continued = [];
          state.continueDeadline = state.handEndedAt + revealTime(g) + PACE.continueWait;
        }
        break;
      }
      case 'continue':
        if (g.phase !== 'handOver' || move.hand !== g.handNumber || state.continued.includes(move.seat)) return false;
        state.continued.push(move.seat);
        break;
      case 'deal':
        if (g.phase !== 'handOver' || move.hand !== g.handNumber) return false;
        G.nextHand(g);
        state.handEndedAt = null; state.continued = []; state.continueDeadline = null;
        break;
      case 'newGame': {
        const fresh = newTableState(state.seats);
        Object.assign(state, fresh, { version: state.version });
        break;
      }
      default: return false;
    }
  } catch (e) {
    if (!(e instanceof G.IllegalMove)) console.error(e);
    return false;
  }
  state.version += 1;
  return true;
}

/** The next thing the host should do on its own, with how long to wait first: a bot's turn
 *  ({ seat, style }) or a move ({ move }) — or null when it's waiting on a person. */
export function nextHostStep(state) {
  if (state.paused) return null;
  const g = state.game;
  const fast = onlyBotsLeft(state);
  switch (g.phase) {
    case 'betting': {
      const s = g.turn;
      if (state.seats[s].kind !== 'bot') return null;
      return { delay: fast ? PACE.fastBot : PACE.bot, seat: s, style: g.botStyles[s] || 'grinder' };
    }
    case 'handOver': {
      const deal = { type: 'deal', hand: g.handNumber };
      const ended = state.handEndedAt || Date.now();
      const shown = ended + revealTime(g);
      if (waitingToContinue(state).length) return { delay: Math.max(0, state.continueDeadline - Date.now()), move: deal };
      if (fast) return { delay: Math.max(0, shown + PACE.fastPause - Date.now()), move: deal };
      const pause = g.result && g.result.showdown ? PACE.showdownPause : PACE.handPause;
      // Everyone who folded has tapped Continue: deal after a short beat.
      const done = state.continued.length ? Math.min(shown + pause, Date.now() + 400) : shown + pause;
      return { delay: Math.max(0, done - Date.now()), move: deal };
    }
    default:
      return null;
  }
}

/** Runs the host's steps: a bot thinks (in the background) while the pause runs, and its
 *  move is played once both are done — unless the table moved on in the meantime. */
export class Pacer {
  constructor(onMove) {
    this.onMove = onMove;
    this.token = 0;
    this.timer = null;
  }

  schedule(state) {
    this.cancel();
    const step = nextHostStep(state);
    if (!step) return;
    const token = this.token, due = Date.now() + step.delay;
    const move = step.move ? Promise.resolve(step.move)
      : think(state.game, step.seat, step.style).then((m) => ({ ...m, seat: step.seat }));
    move.then((m) => {
      if (token !== this.token) return;
      this.timer = setTimeout(() => { if (token === this.token) this.onMove(m); }, Math.max(0, due - Date.now()));
    });
  }

  cancel() { this.token += 1; clearTimeout(this.timer); }
}

/** Runs a table on this device (the host). `onState` gets every new state. */
export class LocalHost {
  constructor(state, onState) {
    this.state = state;
    this.onState = onState;
    this.pacer = new Pacer((move) => this.send(move));
    this.publish();
  }

  send(move) {
    if (applyMove(this.state, move)) this.publish();
  }

  publish() {
    this.onState(this.state);
    this.pacer.schedule(this.state);
  }

  stop() { this.pacer.cancel(); }
}
