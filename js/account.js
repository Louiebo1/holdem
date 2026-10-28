// Signing in with Google — the same file in every family card game. The canonical copy is
// ~/code/cardgames-home/shared/account.js; copy it unchanged into each game's js/ (Louie,
// 2026-10-28: "this should be the same for all games"). All the games live on
// louiebo1.github.io and share the Firebase project hearts-659fc, so signing in on one game
// signs that browser in for all of them.
//
// Signed in, a person's name and statistics are kept in the Realtime Database at
//   /users/UID   { name, email, google, seen, games: { holdem: {…}, cribbage: {…}, … } }
// which only that person can read or write (database.rules.json). The games never see the
// Google password. Signed out, nothing changes: everything stays in the browser as before.
//
// Online tables use the same Firebase sign-in: anonymous when signed out. Signing in links
// Google to that anonymous id, so a seat at a table stays yours.

import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const HINT = 'cards.account';     // { email, name } while signed in — shared by every game (same site).
const LINKED = 'cards.linked.';   // + game id: the account this browser's stats were last merged into.

function stored(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function store(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));

let loading = null;
/** Firebase, loaded once per page: { auth, db, A (auth functions), D (database functions) }. */
export function firebase() {
  if (!loading) {
    loading = (async () => {
      const [appMod, A, D] = await Promise.all([
        import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-database.js'),
      ]);
      const app = appMod.initializeApp(firebaseConfig);
      const auth = A.getAuth(app);
      await auth.authStateReady();      // Wait for the saved sign-in before deciding anything.
      return { auth, db: D.getDatabase(app), A, D };
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** The id this browser plays under at online tables: the Google account when signed in,
 *  otherwise an anonymous one (kept by the browser, so a dropped player gets their seat back). */
export async function playerId() {
  const { auth, A } = await firebase();
  if (!auth.currentUser) await A.signInAnonymously(auth);
  return auth.currentUser.uid;
}

const isGoogle = (user) => Boolean(user && !user.isAnonymous && user.providerData.some((p) => p.providerId === 'google.com'));
const firstName = (full) => String(full || '').trim().split(/\s+/)[0].slice(0, 16);

let current = stored(HINT);       // { email, name } or null — known before Firebase loads.
const watchers = new Set();
function changed() { for (const fn of [...watchers]) fn(); }

function setUser(user) {
  const was = JSON.stringify(current);
  current = isGoogle(user) ? { email: user.email || '', name: (current && current.name) || '' } : null;
  store(HINT, current);
  if (JSON.stringify(current) !== was) changed();
}

/** Who's signed in, for the screens. */
export const account = {
  get signedIn() { return Boolean(current); },
  get email() { return current ? current.email : ''; },
  /** Calls `fn` whenever signing in or out changes anything; returns a function to stop. */
  watch(fn) { watchers.add(fn); return () => watchers.delete(fn); },
};

// MARK: Keeping one game's name and statistics with the account

let game = null;        // { id, name(), setName(n), stats?(), setStats?(s) }
let following = null;   // The uid whose record is being followed.
let unsubs = [];
let lastName = null, lastStats = null;    // What the record holds, so unchanged values aren't rewritten.
let started = false;

/** Each game calls this once at startup. `stats`/`setStats` are left out by a game without statistics. */
export function syncGame(options) {
  game = options;
  // Signed in on this browser (in any game): use that name right away, then load Firebase.
  if (current) {
    if (current.name && !game.name()) game.setName(current.name);
    start();
  }
}

async function start() {
  if (started) return;
  started = true;
  try {
    const { auth, A } = await firebase();
    A.onAuthStateChanged(auth, (user) => { setUser(user); if (isGoogle(user)) follow(user); else unfollow(); });
  } catch (e) {
    started = false;
    console.warn('Sign-in unavailable', e);
  }
}

/** Numbers: the larger of the two (so stats from before signing in are never lost or doubled). */
function mergeMax(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && a.length >= (Array.isArray(b) ? b.length : 0) ? a : b;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    // A "best ever" record ({ rank, … }): keep the better one whole.
    if (typeof a.rank === 'number' && typeof b.rank === 'number') return a.rank >= b.rank ? a : b;
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = k in a && k in b ? mergeMax(a[k], b[k]) : (k in a ? a[k] : b[k]);
    return out;
  }
  return a ?? b;
}

async function follow(user) {
  if (!game || following === user.uid) return;
  unfollow();
  following = user.uid;
  const { db, D } = await firebase();
  const me = D.ref(db, `users/${user.uid}`);
  let cloud = {};
  try { cloud = (await D.get(me)).val() || {}; } catch (e) { console.warn('Could not read the account', e); following = null; return; }
  if (following !== user.uid) return;

  const update = { email: user.email || '', google: user.displayName || '', seen: D.serverTimestamp() };
  // One name for every game: the account's, or else this game's (or the Google first name).
  if (cloud.name) { if (cloud.name !== game.name()) game.setName(cloud.name); }
  else update.name = game.name() || firstName(user.displayName) || 'Player';
  lastName = cloud.name || update.name;
  if (!game.name()) game.setName(lastName);
  current = { email: user.email || '', name: lastName };
  store(HINT, current);

  if (game.stats) {
    const theirs = cloud.games && cloud.games[game.id];
    const mine = plain(game.stats());
    // The first time this browser joins the account, its stats are merged in; after that the
    // account's copy is the real one (it may have moved on from another device).
    const merged = !theirs ? mine : stored(LINKED + game.id) === user.uid ? theirs : mergeMax(theirs, mine);
    if (theirs) game.setStats(plain(merged));
    update[`games/${game.id}`] = merged;
    lastStats = JSON.stringify(merged);
    store(LINKED + game.id, user.uid);
  }
  try { await D.update(me, update); } catch (e) { console.warn('Could not save to the account', e); }

  // Changes from other devices and games, live.
  unsubs.push(D.onValue(D.ref(db, `users/${user.uid}/name`), (snap) => {
    const name = snap.val();
    if (!name) return;
    lastName = name;
    if (current) { current.name = name; store(HINT, current); }
    if (name !== game.name()) game.setName(name);
  }));
  if (game.stats) {
    unsubs.push(D.onValue(D.ref(db, `users/${user.uid}/games/${game.id}`), (snap) => {
      const v = snap.val();
      if (!v || JSON.stringify(v) === lastStats) return;
      lastStats = JSON.stringify(v);
      if (JSON.stringify(v) !== JSON.stringify(plain(game.stats()))) game.setStats(v);
    }));
  }
  changed();
}

function unfollow() {
  for (const u of unsubs) u();
  unsubs = [];
  following = null;
  lastName = null; lastStats = null;
}

/** The game's name changed here: keep it with the account (and so for every game). */
export function pushName(name) {
  if (!following || !name || name === lastName) return;
  lastName = name;
  if (current) { current.name = name; store(HINT, current); }
  firebase().then(({ db, D }) => D.set(D.ref(db, `users/${following}/name`), name)).catch((e) => console.warn(e));
}

/** The game's statistics changed here (a game finished, or a reset). */
export function pushStats() {
  if (!following || !game || !game.stats) return;
  const now = plain(game.stats());
  if (JSON.stringify(now) === lastStats) return;
  lastStats = JSON.stringify(now);
  firebase().then(({ db, D }) => D.set(D.ref(db, `users/${following}/games/${game.id}`), now)).catch((e) => console.warn(e));
}

// MARK: Signing in and out

const QUIET = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);
const PROBLEMS = {
  'auth/popup-blocked': 'The sign-in window was blocked. Allow pop-ups for this site and try again.',
  'auth/network-request-failed': 'Couldn’t reach Google. Check the internet connection and try again.',
  'auth/operation-not-allowed': 'Google sign-in isn’t turned on for the family games yet.',
  'auth/unauthorized-domain': 'Google sign-in isn’t allowed on this web address yet.',
};

/** Opens Google's sign-in window. Resolves to null when done (or cancelled), or a message. */
export async function signIn() {
  try {
    const { auth, A } = await firebase();
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      if (auth.currentUser && auth.currentUser.isAnonymous) await A.linkWithPopup(auth.currentUser, provider);
      else await A.signInWithPopup(auth, provider);
    } catch (e) {
      // That Google account was already used (on another device): sign in to it instead.
      const credential = e.code === 'auth/credential-already-in-use' && A.GoogleAuthProvider.credentialFromError(e);
      if (!credential) throw e;
      await A.signInWithCredential(auth, credential);
    }
    const user = auth.currentUser;
    setUser(user);
    if (!started) start();
    else follow(user);      // Linking keeps the same user, so the auth listener doesn't fire.
    setTimeout(() => welcome(user), 700);   // A moment for the account's name to arrive.
    return null;
  } catch (e) {
    if (QUIET.has(e.code)) return null;
    console.warn('Sign-in failed', e);
    return PROBLEMS[e.code] || `Sign-in didn’t work (${e.code || e.message}).`;
  }
}

export async function signOut() {
  unfollow();
  try { const { auth, A } = await firebase(); await A.signOut(auth); } catch (e) { console.warn(e); }
  setUser(null);
}

// MARK: On screen: the start screen, Settings, the welcome

const STYLE = `
.google-btn { display: inline-flex; align-items: center; gap: 10px; padding: 0 16px 0 12px; height: 42px;
  border-radius: 21px; border: 1px solid #747775; background: #fff; color: #1f1f1f; font: 500 15px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.google-btn:disabled { opacity: .6; cursor: default; }
.google-btn svg { width: 20px; height: 20px; flex: none; }
.account-lobby { margin: 10px auto 4px; display: flex; flex-direction: column; align-items: center; gap: 5px; text-align: center; }
.account-lobby .why { font-size: 13px; opacity: .8; max-width: 300px; line-height: 1.3; }
.account-lobby .signed-in { font-size: 14px; opacity: .9; }
.account-lobby .signed-in b { color: #7fd38a; }
.account { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(127,127,127,.35); text-align: left; }
.account .account-title { font-weight: 700; margin-bottom: 4px; }
.account p { margin: 4px 0 8px; font-size: .92em; line-height: 1.35; }
.account .small { font-size: .82em; opacity: .8; }
.account-problem { color: #ff8a73; font-size: 13px; margin: 4px 0; }
.account-welcome { position: fixed; left: 50%; top: max(16px, env(safe-area-inset-top)); transform: translate(-50%, -20px); opacity: 0;
  z-index: 1000; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px); box-sizing: border-box;
  padding: 12px 18px; border-radius: 16px; background: #fff; color: #1f1f1f; box-shadow: 0 6px 24px rgba(0,0,0,.35);
  font: 15px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; transition: opacity .35s, transform .35s; }
.account-welcome.show { opacity: 1; transform: translate(-50%, 0); }
.account-welcome img, .account-welcome .initial { width: 40px; height: 40px; border-radius: 50%; flex: none; }
.account-welcome .initial { display: grid; place-items: center; background: #1a73e8; color: #fff; font-weight: 700; font-size: 18px; }
.account-welcome small { display: block; color: #5f6368; font-size: 13px; }`;

// Google's "G", for the sign-in button (as Google asks the button to show).
const G_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

function addStyle() {
  if (document.getElementById('account-style')) return;
  const s = document.createElement('style');
  s.id = 'account-style'; s.textContent = STYLE;
  document.head.appendChild(s);
}
const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

let firebaseReady = false;
/** Start loading Firebase now, so a tap on the button can open Google's window straight away
 *  (browsers block windows that open long after the tap). */
function warmUp(redraw) {
  firebase().then(() => { firebaseReady = true; if (current && !started) start(); redraw(); })
    .catch(() => redraw('Couldn’t reach Google sign-in. Check the internet connection.'));
}

/** The white "Sign in with Google" button. `onProblem(message)` shows what went wrong. */
function googleButton(onProblem, redraw) {
  const b = make('button', 'google-btn');
  b.type = 'button';
  b.innerHTML = G_LOGO;
  b.appendChild(make('span', '', firebaseReady ? 'Sign in with Google' : 'Sign in with Google…'));
  b.disabled = !firebaseReady;
  b.onclick = async () => {
    b.disabled = true;
    b.lastChild.textContent = 'Signing in…';
    const problem = await signIn();
    onProblem(problem || '');
    redraw();
  };
  return b;
}

/** Keeps `box` drawn by `draw` until it leaves the page. */
function live(box, draw) {
  let problem = '';
  const redraw = (p) => { if (p !== undefined) problem = p; draw(problem, redraw); };
  const stop = account.watch(() => { if (!box.isConnected) stop(); else redraw(); });
  warmUp(redraw);
  redraw();
  return box;
}

/** For the start screen, under "Playing as": the Google button, or who's signed in. */
export function accountLobby() {
  addStyle();
  const box = make('div', 'account-lobby');
  return live(box, (problem, redraw) => {
    box.replaceChildren();
    if (account.signedIn) {
      const line = make('div', 'signed-in');
      line.innerHTML = '<b>✓</b> ';
      line.appendChild(document.createTextNode(`Signed in with Google · ${account.email}`));
      box.appendChild(line);
    } else {
      box.appendChild(googleButton((p) => redraw(p), redraw));
      box.appendChild(make('div', 'why', 'Keep your name and stats on every device, for all the family card games.'));
    }
    if (problem) box.appendChild(make('div', 'account-problem', problem));
  });
}

/** The Google part of Settings: what's kept, and Sign Out. `button(text, cls, onclick)` is the game's own. */
export function accountPanel(button) {
  addStyle();
  const box = make('div', 'account');
  return live(box, (problem, redraw) => {
    box.replaceChildren();
    box.appendChild(make('div', 'account-title', 'Google Sign-In'));
    if (account.signedIn) {
      box.appendChild(make('p', '', `Signed in as ${account.email}. Your name and statistics are kept with your Google sign-in, so they’re the same in every family card game, on every phone, tablet and computer.`));
      box.appendChild(button('Sign Out', '', async () => { await signOut(); redraw(); }));
    } else {
      box.appendChild(make('p', '', 'Sign in with Google to keep your name and statistics on every phone, tablet and computer — for all the family card games.'));
      box.appendChild(make('p', 'small', 'Kept with your sign-in: your name, email address and game statistics, in the family’s game database. Only you can see your statistics. Google checks your password — the games never see it.'));
      box.appendChild(googleButton((p) => redraw(p), redraw));
    }
    if (problem) box.appendChild(make('div', 'account-problem', problem));
  });
}

/** A friendly hello right after signing in. */
function welcome(user) {
  addStyle();
  const name = (current && current.name) || firstName(user.displayName) || 'there';
  const card = make('div', 'account-welcome');
  if (user.photoURL) {
    const img = make('img');
    img.src = user.photoURL; img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.replaceWith(make('div', 'initial', name[0].toUpperCase()));
    card.appendChild(img);
  } else card.appendChild(make('div', 'initial', name[0].toUpperCase()));
  const text = make('div', '', `Welcome, ${name}!`);
  text.appendChild(make('small', '', 'Your name and stats are saved — the same on every device.'));
  card.appendChild(text);
  document.body.appendChild(card);
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('show')));
  setTimeout(() => { card.classList.remove('show'); setTimeout(() => card.remove(), 400); }, 4500);
}

/** The line under the statistics table. */
export const statsNote = () => (account.signedIn
  ? 'Kept with your Google sign-in — the same on every device.'
  : 'Kept on this device. Sign in with Google on the start screen to keep them on every device.');
