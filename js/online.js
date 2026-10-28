// Playing with friends through Firebase (Louie's free-plan project, shared with Hearts,
// Cribbage, Gin, 500 and Pinochle; the database rules only open /tables). A table lives at
// /tables/holdem-CODE:
//   meta      { hostUid, epoch, started, created } — epoch goes up each time the host changes
//   seats     [ { kind: 'person' | 'bot' | 'open', name, uid, standIn } ] ×6 or ×9
//   state     the whole table state as JSON (written only by the host)
//   moves     moves people send ({ uid, move }); the host applies and deletes them
//   presence  { uid: true } — Firebase removes an entry the moment that browser drops
// The host's browser runs the game and the bots. If the host drops, the first other
// person still connected takes over. A person who drops pauses the game until they're
// back (same browser = same seat); the host may let a bot play for them meanwhile.
// The host stamps the state with its epoch, so an old host whose phone wakes up after
// someone else took over can't write over the game.

import { firebaseConfig } from './firebase-config.js';
import { firebase, playerId, account } from './account.js';
import { applyMove, newTableState, Pacer, BOT_NAMES, shuffledList } from './table.js';

const PREFIX = 'holdem-';
export const onlineAvailable = () => Boolean(firebaseConfig && firebaseConfig.apiKey);

let fb = null;      // { db, uid, api }

// The Firebase sign-in is shared with Google sign-in (account.js): anonymous unless the
// person signed in with Google. Signing in or out gets a fresh id for the next table (a
// table already open keeps the one it has).
let signedIn = account.signedIn;
account.watch(() => { if (account.signedIn !== signedIn) { signedIn = account.signedIn; if (fb) fb.stale = true; } });

async function connect() {
  if (fb && !fb.stale) return fb;
  const { db, D } = await firebase();
  fb = { db, uid: await playerId(), api: D };
  return fb;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';       // No I or O (they look like 1 and 0).
const newCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');

/** One table, seen from this browser. Calls `onUpdate()` whenever anything changes. */
export class OnlineTable {
  constructor(code, onUpdate) {
    this.code = code;
    this.path = `tables/${PREFIX}${code}`;
    this.onUpdate = onUpdate;
    this.meta = null; this.seats = []; this.state = null; this.presence = {};
    this.unsubs = [];
    this.isHost = false;
    this.epoch = 0;
    this.connected = true;
    this.pacer = new Pacer((move) => { if (this.isHost && this.state && applyMove(this.state, move)) this.publish(); });
  }

  /** Starts a new table with me in the first seat. */
  static async create(name, onUpdate, wanted = null, players = 6) {
    const { db, uid, api } = await connect();
    for (let tries = 0; tries < 20; tries++) {
      const code = tries === 0 && wanted ? wanted : newCode();
      const ref = api.ref(db, `tables/${PREFIX}${code}/meta`);
      const result = await api.runTransaction(ref, (meta) => (meta ? undefined : { hostUid: uid, epoch: 1, started: false, created: Date.now() }));
      if (!result.committed) continue;
      const seats = [{ kind: 'person', name, uid }, ...Array.from({ length: players - 1 }, () => ({ kind: 'open' }))];
      await api.set(api.ref(db, `tables/${PREFIX}${code}/seats`), seats);
      const table = new OnlineTable(code, onUpdate);
      await table.listen();
      return table;
    }
    throw new Error('Could not make a table code — try again.');
  }

  /** Joins (or rejoins) a table by its code. */
  static async join(code, name, onUpdate) {
    const { db, uid, api } = await connect();
    code = code.toUpperCase();
    const meta = (await api.get(api.ref(db, `tables/${PREFIX}${code}/meta`))).val();
    if (!meta) throw new Error(`There's no table ${code}.`);
    const seatsRef = api.ref(db, `tables/${PREFIX}${code}/seats`);
    const result = await api.runTransaction(seatsRef, (seats) => {
      if (!seats) return seats;
      if (seats.some((s) => s && s.uid === uid)) return seats;              // Rejoining my seat.
      if (meta.started) return undefined;                                   // Full: no new players mid-game.
      const open = seats.findIndex((s) => s && s.kind === 'open');
      if (open < 0) return undefined;
      seats[open] = { kind: 'person', name, uid };
      return seats;
    });
    if (!result.committed || !result.snapshot.val().some((s) => s && s.uid === uid)) {
      throw new Error(meta.started ? `Table ${code} has already started.` : `Table ${code} is full.`);
    }
    const table = new OnlineTable(code, onUpdate);
    await table.listen();
    return table;
  }

  get uid() { return fb.uid; }
  get mySeat() { return this.seats.findIndex((s) => s && s.uid === fb.uid); }
  get started() { return Boolean(this.meta && this.meta.started); }

  async listen() {
    const { db, uid, api } = fb;
    const base = this.path;
    // My presence: removed by Firebase itself if this browser disconnects.
    const me = api.ref(db, `${base}/presence/${uid}`);
    this.unsubs.push(api.onValue(api.ref(db, '.info/connected'), (snap) => {
      clearTimeout(this.offlineTimer);
      if (snap.val() === true) {
        api.onDisconnect(me).remove(); api.set(me, true);
        if (!this.connected) { this.connected = true; this.changed(); }
      } else {
        // Only say so if it lasts (it's briefly false while first connecting).
        this.offlineTimer = setTimeout(() => { this.connected = false; this.changed(); }, 2500);
      }
    }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/meta`), (s) => { this.meta = s.val(); this.roleChanged(); }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/seats`), (s) => { this.seats = s.val() || []; this.changed(); }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/presence`), (s) => { this.presence = s.val() || {}; this.presenceChanged(); }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/state`), (s) => {
      const json = s.val();
      if (!this.isHost) { this.state = json ? JSON.parse(json) : null; this.changed(); }
      else if (!this.state && json) { this.state = JSON.parse(json); this.hostStep(); }
    }));
    this.unsubs.push(api.onChildAdded(api.ref(db, `${base}/moves`), (s) => this.isHost && this.hostMove(s)));
  }

  changed() { this.onUpdate(); }

  // MARK: Being the host

  roleChanged() {
    const wasHost = this.isHost;
    this.isHost = Boolean(this.meta && this.meta.hostUid === fb.uid);
    if (this.isHost) this.epoch = this.meta.epoch || 1;
    if (this.isHost && !wasHost) {
      // Just became host (made the table, or took over): pick up any moves waiting.
      const { db, api } = fb;
      api.get(api.ref(db, `${this.path}/moves`)).then((snap) => snap.forEach((m) => { this.hostMove(m); }));
      this.checkPause();          // e.g. the old host is the one who's away.
      this.hostStep();
    }
    if (!this.isHost) this.pacer.cancel();
    this.changed();
  }

  presenceChanged() {
    const { db, api } = fb;
    // The host is gone: the first person still here (by seat) takes over after a moment.
    if (this.meta && !this.presence[this.meta.hostUid]) {
      clearTimeout(this.takeoverTimer);
      this.takeoverTimer = setTimeout(() => {
        if (!this.meta || this.presence[this.meta.hostUid]) return;
        const here = this.seats.filter((s) => s && s.kind !== 'open' && s.uid && this.presence[s.uid]).map((s) => s.uid);
        if (here[0] !== fb.uid) return;
        api.runTransaction(api.ref(db, `${this.path}/meta`), (meta) => {
          if (!meta || this.presence[meta.hostUid]) return undefined;
          meta.hostUid = fb.uid;
          meta.epoch = (meta.epoch || 1) + 1;
          return meta;
        });
      }, 4000);
    }
    if (this.isHost) this.checkPause();
    this.changed();
  }

  /** Pause while a person is away; give a stand-in bot's seat back when they return. */
  checkPause() {
    if (!this.state || !this.started) return;
    let dirty = false;
    this.seats.forEach((seat, i) => {
      if (seat && seat.standIn && this.presence[seat.uid]) {
        this.seats[i] = { kind: 'person', name: seat.name, uid: seat.uid };
        dirty = true;
      }
    });
    // Someone already knocked out can come and go without holding up the game.
    const away = this.seats.findIndex((s, i) => s && s.kind === 'person' && !this.presence[s.uid] && !this.state.game.seats[i]?.out);
    const paused = away >= 0 ? { seat: away, name: this.seats[away].name } : null;
    if (JSON.stringify(paused) !== JSON.stringify(this.state.paused)) { this.state.paused = paused; dirty = true; }
    if (dirty) { this.writeSeats(); this.publish(); }
  }

  hostMove(snap) {
    if (!this.isHost) return;
    const { api } = fb;
    const { uid, move } = snap.val() || {};
    api.remove(snap.ref);
    if (!this.state || !move) return;
    // People may only move for their own seat.
    const seat = this.seats.findIndex((s) => s && s.uid === uid);
    if ('seat' in move && move.seat !== seat) return;
    if (move.type === 'standIn') return this.letBotPlay(move.away);
    if (move.type === 'deal') return;                     // Only the host's own clock deals.
    if (applyMove(this.state, move)) this.publish();
  }

  publish() {
    if (!this.isHost) return;
    const { db, api } = fb;
    const g = this.state.game;
    this.state.seats = this.seats.map((s) => ({ kind: s.kind === 'person' ? 'person' : 'bot', name: s.name, ...(s.standIn ? { standIn: true } : {}) }));
    g.humanSeats = this.state.seats.map((s, i) => (s.kind === 'person' ? i : -1)).filter((i) => i >= 0);
    this.state.seats.forEach((s, i) => { if (s.kind === 'bot' && !g.botStyles[i]) g.botStyles[i] = 'grinder'; });
    this.state.epoch = this.epoch;
    const json = JSON.stringify(this.state), epoch = this.epoch;
    api.runTransaction(api.ref(db, `${this.path}/state`), (current) => {
      try { if (current && JSON.parse(current).epoch > epoch) return undefined; } catch {}
      return json;
    }, { applyLocally: false }).then((result) => {
      if (result.committed || !result.snapshot.val()) return;
      // A newer host has taken over: stop hosting and follow their game.
      this.isHost = false;
      this.pacer.cancel();
      this.state = JSON.parse(result.snapshot.val());
      this.changed();
    });
    this.changed();
    this.hostStep();
  }

  writeSeats() {
    const { db, api } = fb;
    api.set(api.ref(db, `${this.path}/seats`), this.seats);
  }

  hostStep() {
    if (!this.isHost || !this.state) { this.pacer.cancel(); return; }
    this.pacer.schedule(this.state);
  }

  /** The host starts the game: empty seats get bots. */
  async start() {
    if (!this.isHost) return;
    const { db, api } = fb;
    const names = shuffledList(BOT_NAMES.filter((n) => !this.seats.some((s) => s && s.name === n)));
    this.seats = this.seats.map((s) => (s.kind === 'open' ? { kind: 'bot', name: names.pop() } : s));
    this.writeSeats();
    this.state = newTableState(this.seats.map((s) => ({ kind: s.kind, name: s.name })));
    await api.update(api.ref(db, `${this.path}/meta`), { started: true });
    this.publish();
  }

  /** The host lets a bot play for someone who's away; they get the seat back on return. */
  letBotPlay(away) {
    const seat = this.seats[away];
    if (!this.isHost || !seat || seat.kind !== 'person') return;
    this.seats[away] = { kind: 'bot', name: seat.name, uid: seat.uid, standIn: true };
    this.state.game.botStyles[away] = 'grinder';
    this.state.paused = null;
    this.writeSeats();
    this.checkPause();
    this.publish();
  }

  // MARK: Moves from this browser

  send(move) {
    if (this.isHost) {
      if (move.type === 'standIn') return this.letBotPlay(move.away);
      if (applyMove(this.state, move)) this.publish();
      return;
    }
    const { db, uid, api } = fb;
    api.push(api.ref(db, `${this.path}/moves`), { uid, move });
  }

  stop() {
    this.pacer.cancel();
    clearTimeout(this.takeoverTimer); clearTimeout(this.offlineTimer);
    this.unsubs.forEach((u) => u());
    const { db, uid, api } = fb;
    api.remove(api.ref(db, `${this.path}/presence/${uid}`));
  }
}
