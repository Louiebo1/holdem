// A bot thinking in the background (see js/think.js).
import { Bot } from './bot.js';

self.onmessage = (e) => {
  const { id, game, seat, style } = e.data;
  try {
    self.postMessage({ id, move: new Bot({ style }).move(game, seat) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });     // The page thinks it over itself.
  }
};
