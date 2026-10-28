# Hold'em for the web

Plain JavaScript (ES modules, no build step, no Node) so it runs from any static host.
Started 2026-10-28 for Louie: the iPhone app (`~/code/holdem`) in a browser — a No-Limit
Hold'em tournament against the computer, or with family and friends anywhere with a
4-letter code; bots fill empty seats. Built like `~/code/fivehundred-web` (same
table/online/worker scheme, same Firebase project).

## Layout
- `js/cards.js` — cards as ints 0…51 like the app's `Card.index` (suit*13 + rank−2; ♣0 ♦1
  ♥2 ♠3); masks in two 32-bit halves `{ lo: ♣ | ♦<<16, hi: ♥ | ♠<<16 }` (the app's 64-bit
  `Card.mask`); `seeded(seed)` for tests.
- `js/evaluator.js` — the app's `HandEvaluator` (same score layout and hand names).
- `js/preflop.js` — the app's `Preflop` table (169 starting hands, 1,326 combos).
- `js/game.js` — the app's `HoldemGame` as plain JSON: blinds 10/20 up every 10 hands (12
  at 9 players), 1,500 chips, min raise, short all-ins don't reopen betting, heads-up
  blinds, side pots, odd chips, `runoutFrom` (board count when cards went face up after an
  all-in), public `actions` and `tendencies`. Moves `{ type: 'fold'|'check'|'call' }` or
  `{ type: 'raise', to }`; illegal moves throw `IllegalMove`.
- `js/bot.js` — the app's `Bot`, line for line: six styles (Rock, Shark, Trapper, Grinder,
  Bully, Reader), opponent ranges weighted by their betting, Monte Carlo equity (700 deals),
  push/fold, `advice` for Suggest. Bots see only `playerView`. When the app's bots change,
  port the change here. Each bot gets a random secret style (repeats allowed), revealed at
  game over; a stand-in for a dropped person plays Grinder.
- `js/think.js` + `js/worker.js` — bots think in a module Web Worker (`?noworker` = page).
- `js/table.js` — table state (game + seats + paused + `continued`, `handEndedAt`,
  `continueDeadline`), `applyMove`, `nextHostStep` + `Pacer` (the app's pacing: bot 0.9 s,
  hand 2.4 s / showdown 4.5 s, the all-in board a street at a time; after a hand a person
  folded, the next one waits until every such person taps Continue, or 60 s — Louie
  2026-10-28; once every person is out the bots play fast), `LocalHost`.
- `js/online.js` — Firebase (`hearts-659fc`) at `/tables/holdem-CODE`, seats ×6 or ×9;
  same scheme as 500: drop → pause (not for players already knocked out), host may let a
  bot play, host takeover with the epoch guard.
- `js/handstats.js` — the statistics (Louie 2026-10-28, "do all"): results (finishes by place
  at 6 / 9 seats, last 10, win streaks), style (VPIP, PFR, aggression, went to showdown, won
  at showdown → "You play most like… the Shark" by nearest `STYLE_PROFILES`), hands made by
  the river + best hand, all-ins with bad beats / lucky escapes (equity when the chips went
  in, `allInEquity`), starting hands (dealt / won / net big blinds per "AKs"), rivals (who
  knocked me out / whom I knocked out, by bot style — recorded only at game over so styles
  stay secret; `game.knockedOutBy`). `normalize` refills parts Firebase drops. The
  Statistics screen in main.js has tabs Results · Style · Hands · Starting · Rivals.
  `STYLE_PROFILES` come from `jsc tests/args.js -m tests/styles.js -- 600 6 7` (+ 300 9 8),
  averaged; remeasure when the bots change.
- `js/sounds.js` — snap, deal, knock (check), chips (bets), fanfare.
- `js/main.js` — start (Continue Game, Back to Table, 6/9 switch), friends, waiting room,
  table (seats around an oval in % of the table area with me at the bottom, chips and
  dealer button toward the middle, board + pot + result in the middle; your cards and the
  Fold / Check-Call / Bet-Raise buttons below — in a column on the right on a sideways
  phone; raise panel Min/½/¾/Pot/All In + slider), Continue + countdown after a hand you
  folded (everyone still in shows you their cards), watching after you're out (Fast /
  Normal), final standings with styles, menu, settings, statistics, How to Play.
  localStorage `hw.settings`, `hw.stats`, `hw.local`, `hw.table`. Names go through `esc()`.

## Test
- Rules and bots: `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/engine.test.js`
  (the app's EngineTests + 6- and 9-player bot tournaments + the Continue wait).
- Bench: `jsc tests/args.js -m tests/bench.js -- TOURNAMENTS PLAYERS SEED` (run several
  seeds at once). 2026-10-28, 2,400 six-player tournaments: rock 14.8%, shark 19.9, bully
  18.8, reader 16.9, trapper 14.6, grinder 14.9 — the same spread as the app's bench.
- Page: serve with `Cache-Control: no-store` (a small Python server; restart it if pages
  start coming up blank), headless Chrome with its own `--user-data-dir` and `?noworker`.
  Chrome won't make a window narrower than ~500 px: for phone sizes load the page in a
  402×874 (or 874×402) iframe from a scratch page. URL options: `?name=X`, `?play`,
  `?autoplay` (`&record` to count it in the statistics), `?foldtest` (my seat folds every hand: the Continue screen), `?fast`,
  `?nine`, `?newtable=CODE&startafter=N`, `?t=CODE`. Online: simulators' Safari via
  `xcrun simctl openurl` (iPhone `?newtable=TZxx&startafter=2&autoplay`, iPad
  `?t=TZxx&autoplay`); delete TZ* tables after (`DELETE /tables/holdem-TZxx.json?auth=…`,
  token from anonymous `accounts:signUp`). Verified 2026-10-28: iPhone host + iPad guest
  played together.

## Deploy
Published 2026-10-28: GitHub Pages from `main` (repo
Louiebo1/holdem, public) → https://louiebo1.github.io/holdem/, plus a tile on
`~/code/cardgames-home`. GitHub CLI: `~/bin/gh` (logged in as Louiebo1).

## Google sign-in (2026-10-28)
`js/account.js` is a copy of `~/code/cardgames-home/shared/account.js` — the same file in
every game; change it there and copy it to all of them. It owns the Firebase connection
(`online.js` gets the id from `playerId()`): anonymous unless the person signed in with
Google (the button on the start screen, `accountLobby()`; Sign Out in Settings). Signed in, the name and statistics live at
`/users/UID` (`name`, `email`, `games/<game id>`), private to that person; `main.js` calls
`syncGame(...)` at startup, `pushName` in `saveSettings`, `pushStats` when stats are saved.
