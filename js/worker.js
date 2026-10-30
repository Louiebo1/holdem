// A bot thinking in the background (see js/think.js), or Learn mode's coach working out the odds.
import { Bot } from './bot.js';
import { coach } from './coach.js';

self.onmessage = (e) => {
  const { id, game, seat, style, kind, names } = e.data;
  try {
    if (kind === 'coach') self.postMessage({ id, coach: coach(game, seat, (s) => names[s]) });
    else self.postMessage({ id, move: new Bot({ style }).move(game, seat) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });     // The page thinks it over itself.
  }
};
