// The web app: the start screen, the table, and the overlays. It draws whatever table state
// it's given and turns taps into moves. Built like the app's TableView: everyone around an
// oval, the board and pot in the middle, your cards and betting buttons at the bottom.

import * as G from './game.js';
import { SYMBOL, card, suitOf, rankLabel, rankOf, label, isRedSuit, SPADES } from './cards.js';
import { evaluate, handName, bestFive } from './evaluator.js';
import { STYLES, advice } from './bot.js';
import { newTableState, LocalHost, BOT_NAMES, PACE, revealTime, waitingToContinue, shuffledList } from './table.js';
import { OnlineTable, onlineAvailable } from './online.js';
import { syncGame, pushName, pushStats, accountPanel, accountLobby, statsNote, account } from './account.js';
import { think } from './think.js';
import { play as playSound, sound, unlockSound } from './sounds.js';

const app = document.getElementById('app');
// For checking the page: ?name=X, ?play, ?autoplay, ?foldtest, ?fast, ?nine, ?newtable=CODE&startafter=N.
const params = new URLSearchParams(location.search);

// MARK: Remembered on this device

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const settings = Object.assign({ name: '', back: 'red', largePrint: false, sounds: true, hints: false, players: 6 }, stored('hw.settings', {}));
function saveSettings() {
  store('hw.settings', settings);
  pushName(settings.name);
  document.body.classList.toggle('large-print', settings.largePrint);
  sound.on = settings.sounds;
}
if (params.has('nine')) settings.players = 9;
saveSettings();

const lastTable = {
  get: () => stored('hw.table', null),
  set: (code) => store('hw.table', code),
  clear: () => store('hw.table', null),
};

// A tournament against the computer, saved after every move so a reload doesn't lose it.
const savedGame = {
  get: () => { const s = stored('hw.local', null); return s && s.game && s.game.phase !== 'gameOver' && s.game.seats ? s : null; },
  set: (s) => store('hw.local', s),
};

// Statistics, kept on this device (the app's lines, without iCloud).
const blankLine = () => ({ played: 0, won: 0, podium: 0, placeSum: 0, hands: 0, handsWon: 0, showdownsWon: 0, biggestPot: 0, knockouts: 0 });
const stats = stored('hw.stats', null) || { computer: blankLine(), online: blankLine() };
const saveStats = () => { store('hw.stats', stats); pushStats(); };

const myName = () => settings.name || 'Player';
const fmt = (n) => Number(n).toLocaleString('en-US');
const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

// MARK: Helpers

/** Names come from other people's browsers: never let them be read as HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

function button(text, cls, onclick) {
  const b = el('button', cls);
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function cardEl(c) {
  const e = el('div', 'card' + (isRedSuit(suitOf(c)) ? ' red' : ''));
  e.innerHTML = `<div class="corner"><span class="r">${rankLabel(rankOf(c))}</span><span class="s">${SYMBOL[suitOf(c)]}</span></div><div class="pip">${SYMBOL[suitOf(c)]}</div>`;
  e.setAttribute('aria-label', label(c));
  return e;
}

function backEl() {
  const e = el('div', 'back');
  const inner = el('div');
  inner.style.backgroundImage = `url(img/back_${settings.back}.jpg)`;
  e.appendChild(inner);
  return e;
}

function dialog(title, body, buttons, dismiss) {
  const o = el('div', 'overlay'), p = el('div', 'panel');
  if (title) p.appendChild(el('h2', '', title));
  if (typeof body === 'string') p.appendChild(el('p', '', body));
  else if (body) p.appendChild(body);
  if (buttons && buttons.length) { const row = el('div', 'buttons'); row.append(...buttons); p.appendChild(row); }
  o.appendChild(p);
  if (dismiss) {
    o.dataset.dismiss = '';
    o.dismiss = dismiss;
    o.onclick = (e) => { if (e.target === o) dismiss(); };
  }
  return o;
}

function popup(title, body, buttons, onDismiss) {
  const o = dialog(title, body, buttons.map(([text, cls, then]) => button(text, cls, () => { o.remove(); then?.(); })),
    () => { o.remove(); onDismiss?.(); });
  o.classList.add('popup');
  app.appendChild(o);
  return o;
}

const message = (html, then) => popup('', html, [['OK', 'primary', then]], then);
const confirmThen = (title, html, yes, onYes) => popup(title, html, [['Cancel', ''], [yes, 'primary', onYes]]);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') [...document.querySelectorAll('.overlay[data-dismiss]')].pop()?.dismiss();
});
document.addEventListener('pointerdown', unlockSound);

/** 6 or 9 players, as a two-button switch. */
function sizeSwitch(onChange) {
  const box = el('div', 'switch');
  for (const n of [6, 9]) {
    const b = button(`${n} Players`, settings.players === n ? 'on' : '', () => { settings.players = n; saveSettings(); onChange(); });
    box.appendChild(b);
  }
  return box;
}

// MARK: Start screen

let host = null;      // LocalHost or OnlineTable
let state = null;     // The table state being shown.
const ui = {
  me: 0,
  raising: false, raiseTo: 0,
  hint: null, thinkingHint: false,
  banner: null, bannerShown: null,
  reveal: null,          // { start, from, hand }: the board coming out a street at a time after an all-in.
  holdResultUntil: 0,    // The result waits until the board is out.
  boardShown: 0,         // Board cards already drawn (new ones pop in once).
  sentAt: null,          // Online guest: the state version when I sent a move (no double taps).
  prev: null,            // The last game drawn (a copy), to see what changed.
  recorded: false,
  overlayKey: null,
  fast: false,           // Out of the tournament and watching: play it out quickly (vs the computer).
};
const later = [];

function resetUI() {
  Object.assign(ui, { raising: false, raiseTo: 0, hint: null, thinkingHint: false, banner: null, bannerShown: null, reveal: null,
    holdResultUntil: 0, boardShown: 0, sentAt: null, prev: null, recorded: false, overlayKey: null, fast: false });
  later.splice(0).forEach(clearTimeout);
}

function redrawAt(time) {
  later.push(setTimeout(() => render(), Math.max(0, time - Date.now()) + 20));
}

const isOnline = () => host instanceof OnlineTable;

function leaveTable() {
  const midGame = isOnline() && host.started && state && state.game.phase !== 'gameOver';
  if (isOnline() && !midGame) lastTable.clear();
  showLobby();
}

function lobbyHeader(lobby, tag) {
  lobby.appendChild(el('h1', '', 'Hold’em'));
  lobby.appendChild(el('div', 'tag', tag));
}

function showLobby() {
  host?.stop(); host = null; state = null;
  resetUI();
  if (location.search) history.replaceState(null, '', location.pathname);
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  const fan = el('div', 'fan');
  [10, 11, 12, 13, 14].forEach((r, i) => {
    const e = cardEl(card(SPADES, r));
    e.style.transform = `translateX(-50%) rotate(${(i - 2) * 9}deg)`;
    fan.appendChild(e);
  });
  lobby.appendChild(fan);
  lobbyHeader(lobby, 'No-Limit Texas Hold’em · Tournament');

  const name = el('div', 'name', 'Playing as ');
  name.appendChild(button(settings.name || 'You', 'link', () => askName(showLobby)));
  lobby.appendChild(name);
  lobby.appendChild(accountLobby());          // Sign in with Google (or who's signed in).

  const code = onlineAvailable() && lastTable.get();
  if (code) lobby.appendChild(button(`Back to Table ${code}`, 'big-button primary', () => joinTable(code)));

  const saved = savedGame.get();
  if (saved) {
    const g = saved.game, mine = g.seats[0];
    const detail = mine.out ? `Hand ${g.handNumber} · ${G.playersLeft(g).length} left` : `Hand ${g.handNumber} · You have ${fmt(mine.chips)}`;
    lobby.appendChild(button(`Continue Game · ${detail}`, 'big-button primary', () => playComputer(saved)));
  }
  lobby.appendChild(sizeSwitch(showLobby));
  lobby.appendChild(button(saved ? 'New Game vs the Computer' : 'Play the Computer', 'big-button', () => {
    if (saved) confirmThen('New Game?', 'The tournament you have going will be lost.', 'New Game', () => playComputer());
    else playComputer();
  }));
  const friends = button('Play with Friends', 'big-button', showFriends);
  friends.disabled = !onlineAvailable();
  lobby.appendChild(friends);

  const links = el('div', 'links');
  links.appendChild(button('Settings', 'link', () => showSettings(showLobby)));
  links.appendChild(button('Statistics', 'link', showStats));
  links.appendChild(button('How to Play', 'link', showRules));
  lobby.appendChild(links);
  app.appendChild(lobby);
  if (!settings.name) askName(showLobby);
}

function askName(then) {
  const input = el('input', 'text');
  input.maxLength = 16; input.value = settings.name; input.placeholder = 'Your name'; input.autocomplete = 'nickname';
  const save = () => {
    const name = input.value.trim().slice(0, 16);
    if (!name) { input.focus(); return; }
    settings.name = name; saveSettings(); o.remove(); then?.();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  const o = dialog('Your name?', input, [button('OK', 'primary', save)], settings.name ? () => o.remove() : null);
  o.classList.add('popup');
  app.appendChild(o);
  input.focus();
}

function playComputer(saved = null) {
  let s = saved;
  if (!s) {
    const names = shuffledList(BOT_NAMES.filter((n) => n !== settings.name));
    const seats = [{ kind: 'person', name: settings.name || 'You' }, ...Array.from({ length: settings.players - 1 }, (_, i) => ({ kind: 'bot', name: names[i] }))];
    if (params.has('autoplay')) seats[0].kind = 'bot';     // Testing: bots in every seat.
    s = newTableState(seats);
  }
  ui.me = 0;
  resetUI();
  const keep = !params.has('autoplay') && !params.has('foldtest');
  host = new LocalHost(s, (next) => {
    state = next;
    if (keep) savedGame.set(next.game.phase === 'gameOver' ? null : next);
    update();
    render();
    testFold();
  });
}

// MARK: Playing with friends

function showFriends() {
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobbyHeader(lobby, 'Play with friends');
  lobby.appendChild(sizeSwitch(showFriends));
  lobby.appendChild(button(`Start a ${settings.players}-Seat Table`, 'big-button primary',
    () => withTable(OnlineTable.create(myName(), onTableUpdate, null, settings.players))));
  lobby.appendChild(el('div', 'note', 'or join with a code'));
  const row = el('div', 'row');
  const input = el('input', 'code');
  input.maxLength = 4; input.placeholder = 'CODE'; input.autocapitalize = 'characters'; input.autocomplete = 'off'; input.spellcheck = false;
  const join = button('Join', 'primary', () => { if (input.value.trim().length === 4) joinTable(input.value.trim()); else input.focus(); });
  input.onkeydown = (e) => { if (e.key === 'Enter') join.onclick(); };
  row.append(input, join);
  lobby.appendChild(row);
  lobby.appendChild(el('div', 'note', 'Bots fill any empty seats when the game starts. If someone drops, the game waits until they’re back — they reopen the link, or tap Back to Table on the start screen.'));
  lobby.appendChild(button('Back', '', showLobby));
  app.appendChild(lobby);
}

const joinTable = (code) => withTable(OnlineTable.join(code, myName(), onTableUpdate));

async function withTable(promise) {
  app.innerHTML = '<div class="lobby"><div class="tag">Connecting…</div></div>';
  resetUI();
  try {
    host = await promise;
    lastTable.set(host.code);
    history.replaceState(null, '', `${location.pathname}?t=${host.code}`);
    onTableUpdate();
  } catch (e) {
    const text = (e && e.message) || String(e);
    if (/no table|already started|full/i.test(text)) lastTable.clear();
    showFriends();
    message(esc(text));
  }
}

function onTableUpdate() {
  if (!isOnline()) return;
  ui.me = Math.max(0, host.mySeat);
  if (host.started && host.state) {
    state = host.state;
    update();
    render();
    testAutoplay();
  } else waitingRoom();
}

// Testing online: ?autoplay plays this browser's seat with a bot; ?startafter=N (host)
// starts the table once N people are seated.
let autoTimer = null, autoBusy = false;
function testAutoplay() {
  if (!params.has('autoplay') || !state) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    const g = state.game, me = ui.me;
    if (state.paused || autoBusy) return;
    if (g.phase === 'betting' && g.turn === me) {
      autoBusy = true;
      const version = state.version;
      const move = await think(g, me, 'grinder');
      autoBusy = false;
      if (state.version === version) host.send({ ...move, seat: me });
    } else if (canContinue()) host.send({ type: 'continue', seat: me, hand: g.handNumber });
    document.title = `Holdem ${g.phase} hand ${g.handNumber} chips ${g.seats.map((s) => s.chips).join(',')}`;
  }, 400);
}

// Testing the Continue screen: ?foldtest folds my seat every hand by itself.
function testFold() {
  if (!params.has('foldtest') || !state) return;
  const g = state.game;
  if (g.phase === 'betting' && g.turn === ui.me && !state.paused) {
    setTimeout(() => { if (isMyTurn(state.game)) perform({ type: G.canCheck(g, ui.me) ? 'check' : 'fold' }); }, 300);
  }
}

function waitingRoom() {
  const t = host;
  const want = Number(params.get('startafter') || 0);
  if (want && t.isHost && t.seats.filter((x) => x.kind === 'person').length >= want) { t.start(); return; }
  state = null;
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobby.appendChild(el('div', 'tag', 'Table code'));
  lobby.appendChild(el('h1', 'table-code', t.code));
  const link = `${location.origin}${location.pathname}?t=${t.code}`;
  const share = button('Send the Link', 'primary', async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Hold’em', text: `Join my Hold’em table: ${t.code}`, url: link }); } catch {} return; }
    try { await navigator.clipboard.writeText(link); share.textContent = 'Link Copied'; } catch { share.textContent = link; }
  });
  lobby.appendChild(share);
  const list = el('div', 'seats-list');
  t.seats.forEach((seat, i) => {
    const row = el('div', 'seat-row');
    if (seat.kind === 'open') row.innerHTML = `<span class="n">${i + 1}</span><i>Open — a bot sits here if nobody joins</i>`;
    else row.innerHTML = `<span class="n">${i + 1}</span><b>${esc(seat.name)}</b>${seat.uid === t.uid ? '<span class="you">you</span>' : ''}<span class="dot ${t.presence[seat.uid] ? 'on' : ''}"></span>`;
    list.appendChild(row);
  });
  lobby.appendChild(list);
  if (t.isHost) {
    const open = t.seats.filter((s) => s.kind === 'open').length;
    lobby.appendChild(button(open ? `Start — bots take ${open} seat${open === 1 ? '' : 's'}` : 'Start the Game', 'big-button primary', () => t.start()));
  } else {
    const hostSeat = t.seats.find((s) => s.uid === t.meta?.hostUid);
    lobby.appendChild(el('div', 'note', `Waiting for ${hostSeat ? esc(hostSeat.name) : 'the host'} to start…`));
  }
  lobby.appendChild(button('Leave', '', leaveTable));
  app.appendChild(lobby);
}

// MARK: Who's who

const seatCount = () => state.game.seats.length;
const positionOf = (seat) => (seat - ui.me + seatCount()) % seatCount();
const nameOf = (seat) => esc(state.seats[seat].name) + (state.seats[seat].standIn ? ' (bot)' : '');
const who = (seat) => (seat === ui.me ? 'You' : nameOf(seat));
const isMyTurn = (g) => g.phase === 'betting' && g.turn === ui.me && !state.paused && !revealing();
const waitingOnHost = () => isOnline() && !host.isHost && ui.sentAt !== null && ui.sentAt === state.version;
const revealing = () => Date.now() < ui.holdResultUntil;
const resultShowing = (g) => !!g.result && !revealing();

/** I folded this hand (and I'm still in the tournament). */
function foldedThisHand(g) {
  const s = g.seats[ui.me];
  return s && s.inHand && s.folded && !s.out;
}
/** After a hand I folded, everyone still in at the end shows me their cards. */
const showsCards = (g, seat) => resultShowing(g) && foldedThisHand(g) && G.isLive(g, seat);
/** The hand is over, I folded it, and the next one is waiting on me. */
const canContinue = () => !!state && state.game.phase === 'handOver' && resultShowing(state.game)
  && waitingToContinue(state).includes(ui.me);

// MARK: What changed: sounds, banners, the board, the stats

function showBanner(b, ms = 2400) {
  ui.banner = { ...b, until: Date.now() + ms, id: Math.random() };
  redrawAt(ui.banner.until);
}

function update() {
  const g = state.game, old = ui.prev, now = Date.now();
  if (ui.sentAt !== null && state.version !== ui.sentAt) ui.sentAt = null;
  const newGame = !old || g.handNumber < old.handNumber || (old.phase === 'gameOver' && g.phase !== 'gameOver');
  const newHand = newGame || old.handNumber !== g.handNumber;
  if (newHand) {
    if (old) playSound('deal');
    Object.assign(ui, { reveal: null, holdResultUntil: 0, boardShown: 0, hint: null, raising: false });
    if (newGame) { ui.recorded = false; ui.fast = false; }
    if (old && !newGame && G.bigBlind(g) > G.bigBlind(old)) showBanner({ title: 'Blinds up', detail: `${fmt(G.smallBlind(g))} / ${fmt(G.bigBlind(g))}` });
  }
  if (old && !newHand) {
    if (g.actions.length > old.actions.length) {
      const a = g.actions[g.actions.length - 1];
      if (a.kind === 'check') playSound('knock');
      else if (a.kind !== 'fold') playSound('chips');
    }
    if (g.board.length > old.board.length) {
      // After an all-in the board comes out a street at a time, and the result waits for it.
      if (g.result && !old.result && g.runoutFrom !== null && g.runoutFrom !== undefined) {
        ui.reveal = { start: now, from: Math.max(old.board.length, g.runoutFrom) };
        ui.holdResultUntil = params.has('fast') ? now : now + revealTime(g);
        for (let t = PACE.revealStart; t <= revealTime(g); t += PACE.street) redrawAt(now + t);
        redrawAt(ui.holdResultUntil);
      } else playSound('snap');
    }
    if (g.result && !old.result) handEnded(g);
    if (g.turn !== old.turn || g.street !== old.street) { ui.hint = null; ui.raising = false; }
  }
  const place = G.place(g, ui.me);
  if (place !== null && !ui.recorded && old) {
    ui.recorded = true;
    if (!params.has('autoplay') && !params.has('foldtest')) {
      const line = stats[isOnline() ? 'online' : 'computer'];
      line.played += 1; line.placeSum += place;
      if (place === 1) line.won += 1; else if (place <= 3) line.podium += 1;
      saveStats();
    }
    if (place === 1) playSound('fanfare', Math.max(0, ui.holdResultUntil - now) / 1000);
    if (place > 1 && !isOnline()) ui.fast = true;
  }
  ui.prev = JSON.parse(JSON.stringify(g));
}

function handEnded(g) {
  const r = g.result, me = ui.me;
  if (g.seats[me].inHand && !params.has('autoplay') && !params.has('foldtest')) {
    const line = stats[isOnline() ? 'online' : 'computer'];
    const won = r.won[me] || 0;
    line.hands += 1;
    if (won - g.seats[me].committed > 0) { line.handsWon += 1; if (r.showdown) line.showdownsWon += 1; }
    line.biggestPot = Math.max(line.biggestPot, won);
    if (won > 0) line.knockouts += r.busted.filter((s) => s !== me).length;
    saveStats();
  }
  const at = Math.max(Date.now(), ui.holdResultUntil);
  later.push(setTimeout(() => {
    for (const s of r.busted) {
      const p = G.place(g, s);
      showBanner(s === me ? { title: 'You’re out', detail: `${ordinal(p)} place` } : { title: `${nameOf(s)} is out`, detail: `${ordinal(p)} place` }, 2600);
    }
    render();
  }, at - Date.now()));
}

// MARK: The table

function sizes() {
  const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
  const sideways = w > h && h < 520;
  const hand = Math.floor(Math.min(w * 0.17, sideways ? h * 0.24 : h * 0.11, 92));
  const scale = Math.max(1, Math.min(1.45, Math.min(w, h * 1.3) / 560));
  return { sideways, hand, scale, w, h };
}

function render() {
  if (!state) return;
  const g = state.game, me = ui.me, now = Date.now();
  const size = sizes();
  const screen = el('div', 'screen');
  const table = el('div', 'table' + (size.sideways ? ' sideways' : ''));
  table.style.setProperty('--hand-w', size.hand + 'px');
  table.style.setProperty('--seat-scale', size.scale);
  table.style.setProperty('--board-w', Math.floor(Math.min(size.w * (size.sideways ? 0.07 : 0.13), size.h * (size.sideways ? 0.13 : 0.075), 64 * size.scale)) + 'px');
  if (isOnline() && !host.connected) table.appendChild(el('div', 'banner-line', 'Connection lost — reconnecting…'));
  table.appendChild(topBar(g));
  table.appendChild(feltArea(g, now));
  const bottom = el('div', 'bottom');
  bottom.appendChild(controls(g));
  bottom.appendChild(myCards(g));
  table.appendChild(bottom);
  screen.appendChild(table);
  const old = app.querySelector(':scope > .screen');
  if (old) old.replaceWith(screen);
  else { app.innerHTML = ''; app.appendChild(screen); }

  let overlay = null, key = null;
  if (state.paused && state.paused.seat !== me) { overlay = pausedPanel(); key = 'paused'; }
  else if (g.phase === 'gameOver' && !revealing()) { overlay = finalPanel(g); key = `final:${g.handNumber}`; }
  if (overlay) {
    if (key === ui.overlayKey) overlay.classList.add('still');
    screen.appendChild(overlay);
  }
  ui.overlayKey = key;
}

function topBar(g) {
  const top = el('div', 'topbar');
  const up = G.handsUntilLevel(g);
  top.appendChild(el('div', 'blinds', `<b>Blinds ${fmt(G.smallBlind(g))} / ${fmt(G.bigBlind(g))}</b><small>${up === 1 ? 'Going up next hand' : `Up in ${up} hands`}</small>`));
  top.appendChild(el('div', 'hand-no', `<b>Hand ${g.handNumber}</b><small>${G.playersLeft(g).length} of ${g.seats.length} left</small>`));
  const menu = button('•••', 'menu', showMenu);
  menu.setAttribute('aria-label', 'Game menu');
  top.appendChild(menu);
  return top;
}

/** Where a seat sits around the oval, in % of the table area: me at the bottom, then clockwise. */
function seatSpot(seat) {
  const angle = (90 + positionOf(seat) * 360 / seatCount()) * Math.PI / 180;
  return { x: 50 + 41 * Math.cos(angle), y: 50 + 39 * Math.sin(angle) };
}
const toward = (spot, t) => ({ x: spot.x + (50 - spot.x) * t, y: spot.y + (50 - spot.y) * t });
const at = (e, p) => { e.style.left = p.x + '%'; e.style.top = p.y + '%'; return e; };

function feltArea(g, now) {
  const area = el('div', 'felt-area' + (g.seats.length > 6 ? ' nine' : ''));
  area.appendChild(el('div', 'felt'));
  const center = el('div', 'center');
  const total = g.result ? g.result.pots.reduce((a, p) => a + p.amount, 0) : G.pot(g);
  center.appendChild(el('div', 'pot' + (total ? '' : ' hidden'), `Pot ${fmt(total)}`));
  center.appendChild(boardEl(g, now));
  center.appendChild(resultLine(g));
  area.appendChild(center);
  g.seats.forEach((s, i) => {
    if (s.bet > 0) at(area.appendChild(el('div', 'chips', `<i></i>${fmt(s.bet)}`)), toward(seatSpot(i), 0.4));
    if (i === g.button && !s.out) {
      const spot = toward(seatSpot(i), s.bet > 0 ? 0.4 : 0.28);
      const d = at(area.appendChild(el('div', 'dealer-button', 'D')), spot);
      if (s.bet > 0) d.style.marginLeft = (seatSpot(i).x > 51 ? -46 : 46) + 'px';
      else if (i === ui.me) { d.style.marginLeft = '62px'; d.style.top = seatSpot(i).y + '%'; }      // Beside my name.
    }
  });
  g.seats.forEach((_, i) => area.appendChild(at(seatEl(g, i), seatSpot(i))));
  if (ui.banner && now < ui.banner.until) {
    const fresh = ui.bannerShown !== ui.banner.id;
    ui.bannerShown = ui.banner.id;
    area.appendChild(el('div', 'banner' + (fresh ? ' fresh' : ''), `<b>${ui.banner.title}</b>${ui.banner.detail ? `<small>${ui.banner.detail}</small>` : ''}`));
  }
  return area;
}

function seatEl(g, seat) {
  const s = g.seats[seat], isMe = seat === ui.me;
  const turn = g.phase === 'betting' && g.turn === seat && !revealing();
  const winner = resultShowing(g) && (g.result.won[seat] || 0) > 0;
  const e = el('div', 'seat' + (s.out ? ' out' : s.folded ? ' folded' : '') + (isMe ? ' mine' : ''));
  if (!isMe) {
    const cards = el('div', 'hole');
    const faceUp = (g.revealed.includes(seat) && (g.phase === 'betting' || g.result)) || showsCards(g, seat);
    if (s.inHand && !s.folded) s.hole.forEach((c) => cards.appendChild(faceUp ? cardEl(c) : backEl()));
    e.appendChild(cards);
  }
  const chips = s.out ? `Out · ${ordinal(G.place(g, seat) || 0)}` : s.chips === 0 && s.inHand && !s.folded && g.phase === 'betting' ? 'All in' : fmt(s.chips);
  const badge = el('div', 'badge' + (turn ? ' turn' : winner ? ' winner' : ''), `<b>${who(seat)}</b><small>${chips}</small>`);
  const uid = isOnline() && state.seats[seat].kind === 'person' && host.seats[seat]?.uid;
  if (uid && !host.presence[uid]) badge.appendChild(el('div', 'away', 'Away'));
  e.appendChild(badge);
  e.appendChild(seatTag(g, seat));
  return e;
}

const madeHand = (g, seat) => (g.board.length >= 3 && g.seats[seat].hole.length === 2 ? handName(evaluate([...g.seats[seat].hole, ...g.board])) : null);

function seatTag(g, seat) {
  const s = g.seats[seat];
  const tag = (text, cls) => el('div', 'tag-line', `<span class="tag ${cls}">${text}</span>`);
  if (resultShowing(g)) {
    const won = g.result.won[seat] || 0;
    const shown = (g.result.showdown && g.result.shown.includes(seat)) || showsCards(g, seat);
    const made = shown ? madeHand(g, seat) : null;
    if (won > 0) {
      const box = tag(`Wins ${fmt(won)}`, 'win');
      if (made && !g.result.showdown) box.appendChild(el('span', 'tag dark', made));
      return box;
    }
    if (made) return tag(made, 'dark');
  } else if (g.phase === 'betting') {
    const a = g.actions.filter((x) => x.seat === seat && x.street === g.street && x.kind !== 'smallBlind' && x.kind !== 'bigBlind').pop();
    if (a) {
      const text = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' }[a.kind];
      const cls = a.kind === 'fold' ? 'faint' : a.kind === 'check' || a.kind === 'call' ? 'blue' : 'orange';
      return tag(a.allIn && a.kind !== 'fold' && a.kind !== 'check' ? 'All in' : text, cls);
    }
  }
  if (s.folded && s.inHand) return tag('Fold', 'faint');
  return tag('&nbsp;', 'clear');
}

/** How many board cards are out on screen: after an all-in they come out a street at a time. */
function shownBoard(g, now) {
  if (!ui.reveal || !revealing()) return g.board.length;
  const elapsed = now - ui.reveal.start;
  if (elapsed < PACE.revealStart) return ui.reveal.from;
  const steps = [3, 4, 5].filter((n) => n > ui.reveal.from && n <= g.board.length);
  const done = 1 + Math.floor((elapsed - PACE.revealStart) / PACE.street);
  return steps[Math.min(done, steps.length) - 1] || ui.reveal.from;
}

function boardEl(g, now) {
  const row = el('div', 'board');
  const shown = shownBoard(g, now);
  if (shown > ui.boardShown && ui.reveal && revealing()) playSound('snap');
  let winning = new Set();
  if (resultShowing(g) && g.result.showdown) {
    const w = g.result.pots[0].winners[0];
    winning = new Set(bestFive([...g.seats[w].hole, ...g.board]));
  }
  for (let i = 0; i < 5; i++) {
    if (i < shown) {
      const c = cardEl(g.board[i]);
      if (i >= ui.boardShown) c.classList.add('turned');
      if (winning.has(g.board[i])) c.classList.add('winner');
      row.appendChild(c);
    } else row.appendChild(el('div', 'slot'));
  }
  ui.boardShown = shown;
  return row;
}

function resultLine(g) {
  const box = el('div', 'result-line');
  if (!resultShowing(g)) return box;
  const r = g.result;
  r.pots.forEach((p, i) => {
    const names = p.winners.map(who);
    const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
    const verb = names.length > 1 ? 'split' : p.winners[0] === ui.me ? 'win' : 'wins';
    const which = r.pots.length > 1 ? (i === 0 ? ' the main pot' : ' a side pot') : '';
    box.appendChild(el('div', i === 0 ? 'main' : 'side', `${list} ${verb}${which} ${fmt(p.amount)}${p.hand ? ` · ${p.hand}` : ''}`));
  });
  box.classList.add('shown');
  return box;
}

function myCards(g) {
  const s = g.seats[ui.me];
  const box = el('div', 'my-cards');
  const row = el('div', 'cards' + (s.folded ? ' folded' : ''));
  s.hole.forEach((c, i) => { const e = cardEl(c); e.style.transform = `rotate(${i === 0 ? -4 : 4}deg)`; row.appendChild(e); });
  box.appendChild(row);
  const board = g.board.slice(0, shownBoard(g, Date.now()));
  let line = '&nbsp;';
  if (s.out) line = `Out · ${ordinal(G.place(g, ui.me) || 0)} place`;
  else if (s.folded && s.inHand) line = 'Folded';
  else if (s.hole.length === 2 && board.length >= 3) line = handName(evaluate([...s.hole, ...board]));
  const badge = el('div', 'my-line', line);
  box.appendChild(badge);
  return box;
}

// MARK: Betting

function controls(g) {
  const box = el('div', 'controls');
  const me = ui.me, s = g.seats[me];
  if (s.out && g.phase !== 'gameOver') {
    box.appendChild(el('div', 'status-line', `You finished ${ordinal(G.place(g, me) || 0)} — watching the rest`));
    const row = el('div', 'row');
    if (!isOnline()) {
      const fast = button(ui.fast ? '⏩ Fast' : '▶︎ Normal speed', 'ghost', () => { ui.fast = !ui.fast; applySpeed(); render(); });
      row.appendChild(fast);
    }
    if (!isOnline() || host.isHost) row.appendChild(button('New Game', 'primary', () => host.send({ type: 'newGame' })));
    row.appendChild(button('Leave', '', leaveTable));
    box.appendChild(row);
    return box;
  }
  if (canContinue()) {
    box.appendChild(button('Continue', 'primary big-action', () => host.send({ type: 'continue', seat: me, hand: g.handNumber })));
    if (state.continueDeadline) {
      const left = Math.max(0, Math.ceil((state.continueDeadline - Date.now()) / 1000));
      box.appendChild(el('div', 'note', `Next hand in ${left} seconds`));
      redrawAt(Date.now() + 1000);
    }
    return box;
  }
  if (isMyTurn(g) && !waitingOnHost()) {
    box.appendChild(ui.raising ? raisePanel(g) : actionButtons(g));
    if (settings.hints) {
      if (ui.hint) box.appendChild(el('div', 'hint', ui.hint));
      else {
        const b = button(ui.thinkingHint ? 'Thinking…' : '💡 Suggest', 'ghost small', suggest);
        b.disabled = ui.thinkingHint;
        box.appendChild(b);
      }
    }
    return box;
  }
  let status = '';
  if (g.phase === 'betting' && !revealing()) status = g.turn === me ? 'Sending…' : `${nameOf(g.turn)} to act…`;
  else if (g.phase === 'handOver' && resultShowing(g)) {
    const waiting = waitingToContinue(state).filter((x) => x !== me).map(nameOf);
    if (waiting.length) status = `Waiting for ${waiting.join(', ')}…`;
  }
  box.appendChild(el('div', 'status-line', status));
  return box;
}

function actionButtons(g) {
  const me = ui.me, owed = G.toCall(g, me), chips = g.seats[me].chips;
  const row = el('div', 'actions');
  const act = (title, detail, cls, onclick) => {
    const b = el('button', 'action ' + cls, `<b>${title}</b>${detail ? `<small>${detail}</small>` : ''}`);
    b.onclick = onclick;
    row.appendChild(b);
  };
  if (owed > 0) act('Fold', '', 'fold', () => perform({ type: 'fold' }));
  if (owed === 0) act('Check', '', 'call', () => perform({ type: 'check' }));
  else act(owed >= chips ? 'All In' : 'Call', fmt(Math.min(owed, chips)), 'call', () => perform({ type: 'call' }));
  if (G.canRaise(g, me)) {
    act(g.currentBet === 0 ? 'Bet' : 'Raise', '', 'raise', () => { ui.raising = true; ui.raiseTo = defaultRaise(g); render(); });
  }
  return row;
}

const clamp = (g, amount) => Math.max(G.minRaiseTo(g, ui.me), Math.min(Math.round(amount), G.maxRaiseTo(g, ui.me)));
/** Bet or raise by this share of the pot (counting my call first, when facing a bet). */
const potRaise = (g, f) => clamp(g, g.currentBet + (G.pot(g) + G.toCall(g, ui.me)) * f);
function defaultRaise(g) {
  if (g.street === G.PREFLOP) return clamp(g, g.currentBet === G.bigBlind(g) ? G.bigBlind(g) * 2.5 : g.currentBet * 3);
  return potRaise(g, 2 / 3);
}

function raisePanel(g) {
  const me = ui.me, low = G.minRaiseTo(g, me), high = G.maxRaiseTo(g, me), step = Math.max(1, G.smallBlind(g));
  const panel = el('div', 'raise-panel');
  const presets = el('div', 'presets');
  const preset = (text, value) => presets.appendChild(button(text, '', () => { ui.raiseTo = value; render(); }));
  preset('Min', low); preset('½ Pot', potRaise(g, 0.5)); preset('¾ Pot', potRaise(g, 0.75)); preset('Pot', potRaise(g, 1)); preset('All In', high);
  panel.appendChild(presets);
  const allIn = ui.raiseTo >= high;
  const word = allIn ? 'All In' : g.currentBet === 0 ? 'Bet' : 'Raise to';
  const confirm = el('button', 'action raise', `<b>${word}</b><small>${fmt(allIn ? high : ui.raiseTo)}</small>`);
  if (high > low) {
    const slider = el('input', 'slider');
    Object.assign(slider, { type: 'range', min: low, max: high, step: 1, value: ui.raiseTo });
    slider.oninput = () => {
      const v = Number(slider.value);
      ui.raiseTo = v >= high - step / 2 ? high : Math.max(low, Math.round(v / step) * step);
      const all = ui.raiseTo >= high;
      confirm.innerHTML = `<b>${all ? 'All In' : g.currentBet === 0 ? 'Bet' : 'Raise to'}</b><small>${fmt(ui.raiseTo)}</small>`;
    };
    panel.appendChild(slider);
  }
  const row = el('div', 'actions');
  const back = el('button', 'action back-btn', '<b>Back</b>');
  back.onclick = () => { ui.raising = false; render(); };
  confirm.onclick = () => perform({ type: 'raise', to: ui.raiseTo >= high ? high : clamp(g, ui.raiseTo) });
  row.append(back, confirm);
  panel.appendChild(row);
  return panel;
}

function perform(move) {
  const g = state.game;
  if (!isMyTurn(g) || waitingOnHost()) return;
  const full = { ...move, seat: ui.me };
  if (!G.canApply(g, full, ui.me)) return;
  ui.raising = false; ui.hint = null;
  if (isOnline() && !host.isHost) { ui.sentAt = state.version; render(); }
  host.send(full);
}

/** What a steady good player would do here (the app's Suggest). */
function suggest() {
  const g = state.game;
  if (!isMyTurn(g) || ui.thinkingHint) return;
  ui.thinkingHint = true;
  render();
  const version = state.version;
  setTimeout(() => {
    const text = advice(g, ui.me);
    ui.thinkingHint = false;
    if (state && state.version === version) ui.hint = text;
    render();
  }, 30);
}

/** Watching after I'm out (vs the computer): the bots play quickly, or at normal speed. */
function applySpeed() {
  // The table plays fast on its own once every person is out; Normal speed slows it back down.
  Object.assign(PACE, ui.fast || params.has('fast') ? { fastBot: 150, fastPause: 800 } : { fastBot: 900, fastPause: 2400 });
  if (host && !isOnline()) host.pacer.schedule(state);
}

// MARK: Overlays

/** The end of the tournament: where everyone finished, and each bot's secret style. */
function finalPanel(g) {
  const myPlace = G.place(g, ui.me);
  const body = el('div', 'final');
  body.appendChild(el('div', 'how', myPlace === 1 ? `Every chip at the table, after ${g.handNumber} hands.` : `You finished ${ordinal(myPlace)} of ${g.seats.length}.`));
  const list = el('div', 'standings');
  const order = g.seats.map((_, i) => i).sort((a, b) => G.place(g, a) - G.place(g, b));
  for (const s of order) {
    const style = state.seats[s].kind === 'bot' && !state.seats[s].standIn && g.botStyles[s] ? STYLES[g.botStyles[s]] : null;
    list.appendChild(el('div', 'standing' + (s === ui.me ? ' mine' : ''),
      `<span class="place">${ordinal(G.place(g, s))}</span><div><b>${who(s)}</b>${G.place(g, s) === 1 ? ' 🏆' : ''}`
      + (style ? `<div class="gold">Turns out… ${nameOf(s)} was ${style.title}</div><small>${style.blurb}</small>` : '') + '</div>'));
  }
  body.appendChild(list);
  const line = stats[isOnline() ? 'online' : 'computer'];
  if (line.played) body.appendChild(el('div', 'note', `${line.won} win${line.won === 1 ? '' : 's'} in ${line.played} tournament${line.played === 1 ? '' : 's'} ${isOnline() ? 'with friends' : 'vs the computer'}`));
  const buttons = [];
  if (!isOnline() || host.isHost) buttons.push(button('Play Again', 'primary', () => host.send({ type: 'newGame' })));
  buttons.push(button('Leave', '', leaveTable));
  return dialog(myPlace === 1 ? 'You won!' : `${who(G.winner(g))} won`, body, buttons);
}

function pausedPanel() {
  const away = state.paused;
  const body = el('div');
  body.appendChild(el('p', '', `Waiting for <b>${esc(away.name)}</b> to come back… They reopen the link, or tap Back to Table on the start screen.`));
  const buttons = [];
  if (isOnline() && host.isHost) {
    buttons.push(button(`Let a Bot Play for ${away.name}`, 'primary', () => host.send({ type: 'standIn', away: away.seat })));
    body.appendChild(el('div', 'note', 'They get their seat back as soon as they return.'));
  }
  buttons.push(button('Leave', '', leaveTable));
  return dialog('Paused', body, buttons);
}

function showMenu() {
  const online = isOnline();
  popup(online ? `Table ${host.code}` : 'Menu', null, [
    ['Statistics', '', showStats],
    ['Settings', '', () => showSettings(render)],
    ['How to Play', '', showRules],
    ...(!online || host.isHost ? [['New Game', '', () => confirmThen('New Game?', online ? 'This starts the tournament over for everyone at the table.' : 'This tournament will be lost.', 'New Game', () => host.send({ type: 'newGame' }))]] : []),
    ['Leave', '', () => {
      if (online && state.game.phase !== 'gameOver') confirmThen('Leave the Table?', 'The game waits for you (or the host lets a bot play). Come back with Back to Table on the start screen.', 'Leave', leaveTable);
      else leaveTable();
    }],
    ['Close', 'primary'],
  ]);
}

function showSettings(after) {
  const form = el('div', 'settings');
  form.innerHTML = `
    <label class="name-setting">Your name <input class="text" id="name" maxlength="16" autocomplete="nickname"></label>
    <label>Card back <select id="back">${['red', 'green', 'blue', 'black'].map((c) => `<option value="${c}" ${settings.back === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}</select></label>
    <label>Large card letters <input type="checkbox" id="large" ${settings.largePrint ? 'checked' : ''}></label>
    <label>Sounds <input type="checkbox" id="sounds" ${settings.sounds ? 'checked' : ''}></label>
    <label>Suggest button (hints) <input type="checkbox" id="hints" ${settings.hints ? 'checked' : ''}></label>`;
  form.querySelector('#name').value = settings.name;
  if (state) form.querySelector('.name-setting').remove();
  const done = () => {
    const name = form.querySelector('#name')?.value.trim().slice(0, 16);
    if (name) settings.name = name;
    settings.back = form.querySelector('#back').value;
    settings.largePrint = form.querySelector('#large').checked;
    settings.sounds = form.querySelector('#sounds').checked;
    settings.hints = form.querySelector('#hints').checked;
    if (!settings.hints) ui.hint = null;
    saveSettings();
    after?.();
  };
  if (!state) form.appendChild(accountPanel(button));     // Not at a table: it could change who holds the seat.
  popup('Settings', form, [['Done', 'primary', done]], done);
}

function showStats() {
  const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
  const rows = [
    ['Tournaments', (l) => l.played], ['Won', (l) => `${l.won} (${pct(l.won, l.played)})`], ['2nd or 3rd', (l) => l.podium],
    ['Average finish', (l) => (l.played ? (l.placeSum / l.played).toFixed(1) : '–')], ['Hands played', (l) => fmt(l.hands)],
    ['Hands won', (l) => `${fmt(l.handsWon)} (${pct(l.handsWon, l.hands)})`], ['At a showdown', (l) => fmt(l.showdownsWon)],
    ['Players knocked out', (l) => l.knockouts], ['Biggest pot', (l) => fmt(l.biggestPot)],
  ];
  const t = el('table', 'stats');
  t.appendChild(el('tr', '', '<th></th><th>vs the Computer</th><th>with Friends</th>'));
  for (const [name, f] of rows) t.appendChild(el('tr', '', `<td>${name}</td><td>${f(stats.computer)}</td><td>${f(stats.online)}</td>`));
  const body = el('div');
  body.appendChild(t);
  body.appendChild(el('div', 'note', statsNote()));
  popup('Statistics', body, [
    ['Reset', '', () => confirmThen('Reset Statistics?', `Every tournament and hand recorded ${account.signedIn ? 'with your Google sign-in' : 'on this device'} is forgotten.`, 'Reset', () => {
      stats.computer = blankLine(); stats.online = blankLine(); saveStats();
    })],
    ['Done', 'primary'],
  ]);
}

function showRules() {
  const body = el('div', 'rules', `
    <p><b>A tournament.</b> Everyone starts with ${fmt(G.STARTING_CHIPS)} chips. The blinds start at 10 / 20 and go up every 10 hands (12 at nine players). Lose all your chips and you're out; the last player with chips wins.</p>
    <p><b>Each hand</b> you get two cards of your own. Five shared cards come out in the middle: three (the flop), then one (the turn), then one more (the river). Your hand is the best five of your two and the five shared.</p>
    <p><b>Betting</b> goes round to the left before the flop and after each new card. Fold (give up the hand), check (pass when nobody has bet), call (match the bet), or bet / raise. A raise must be at least as big as the last one. You can go all in any time: if you're all in and others keep betting, the extra chips go into a side pot you can't win.</p>
    <p><b>The showdown.</b> Whoever is left after the river turns their cards up; the best hand takes the pot. If everyone else folds, the last player takes it without showing. After a hand you folded, everyone still in shows you their cards — tap Continue when you've seen them (or the next hand deals in a minute).</p>
    <p><b>Hands</b>, best first: straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, pair, high card.</p>
    <p><b>The bots</b> each play a secret style — tight, loose, tricky, pushy… You'll find out who was who when the game ends.</p>`);
  popup('How to Play', body, [['Got It', 'primary']]);
}

// MARK: Start

let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(render); });

// Signed in with Google (any of the family games): the name and statistics follow the account.
syncGame({
  id: 'holdem',
  name: () => settings.name,
  setName: (n) => {
    settings.name = n; saveSettings();
    for (const b of document.querySelectorAll('.lobby .name button')) b.textContent = n;
  },
  stats: () => stats,
  setStats: (s) => { stats.computer = Object.assign(blankLine(), s.computer); stats.online = Object.assign(blankLine(), s.online); store('hw.stats', stats); },
});
if (params.get('name')) { settings.name = params.get('name').slice(0, 16); saveSettings(); }
if (params.has('fast')) Object.assign(PACE, { bot: 20, handPause: 60, showdownPause: 60, revealStart: 10, street: 10, revealEnd: 10, fastBot: 20, fastPause: 40 });
const tableCode = params.get('t') || params.get('newtable');
if (tableCode && onlineAvailable()) {
  const go = () => (params.get('newtable') ? withTable(OnlineTable.create(myName(), onTableUpdate, tableCode, settings.players)) : joinTable(tableCode));
  if (settings.name) go(); else askName(go);
} else if (params.has('play') || params.has('autoplay') || params.has('foldtest')) playComputer();
else showLobby();
