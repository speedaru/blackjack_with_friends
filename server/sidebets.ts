// Pure side bet rules: Perfect Pairs and 21+3. No networking, no timers, no randomness.
// Both settle right after the deal, from the player's first two cards and the dealer's up card.

import { RANKS, type Card, type SideBetKind, type Suit } from '../shared/types.js';

export interface SideBetWin {
  /** Name of the winning combination, shown in the log and on the seat. */
  name: string;
  /** Net payout per chip staked, for example 25 for 25:1. */
  multiplier: number;
}

const RED: ReadonlySet<Suit> = new Set(['H', 'D']);

/** Perfect Pairs on the player's first two cards: perfect 25:1, colored 12:1, mixed 5:1. */
export function evaluatePairs(cards: readonly Card[]): SideBetWin | null {
  const [a, b] = cards;
  if (!a || !b || a.rank !== b.rank) return null;
  if (a.suit === b.suit) return { name: 'Perfect pair', multiplier: 25 };
  if (RED.has(a.suit) === RED.has(b.suit)) return { name: 'Colored pair', multiplier: 12 };
  return { name: 'Mixed pair', multiplier: 5 };
}

/** Whether three ranks are consecutive. The ace plays low (A-2-3) or high (Q-K-A), never both (K-A-2). */
function isStraight(cards: readonly Card[]): boolean {
  const idx = cards.map((c) => RANKS.indexOf(c.rank)).sort((x, y) => x - y);
  const run = (v: number[]) => v[1] === v[0]! + 1 && v[2] === v[1]! + 1;
  if (run(idx)) return true;
  // Ace high: count the ace (index 0) as the rank above the king.
  if (idx[0] === 0) return run([...idx.slice(1), RANKS.length].sort((x, y) => x - y));
  return false;
}

/** 21+3: the player's first two cards plus the dealer's up card, read as a three-card poker hand. */
export function evaluate21Plus3(cards: readonly Card[], up: Card): SideBetWin | null {
  const three = [cards[0], cards[1], up].filter((c): c is Card => c !== undefined);
  if (three.length !== 3) return null;
  const flush = three.every((c) => c.suit === three[0]!.suit);
  const trips = three.every((c) => c.rank === three[0]!.rank);
  const straight = isStraight(three);
  if (trips && flush) return { name: 'Suited trips', multiplier: 100 };
  if (straight && flush) return { name: 'Straight flush', multiplier: 40 };
  if (trips) return { name: 'Three of a kind', multiplier: 30 };
  if (straight) return { name: 'Straight', multiplier: 10 };
  if (flush) return { name: 'Flush', multiplier: 5 };
  return null;
}

export function evaluateSideBet(kind: SideBetKind, cards: readonly Card[], up: Card): SideBetWin | null {
  return kind === 'pairs' ? evaluatePairs(cards) : evaluate21Plus3(cards, up);
}
