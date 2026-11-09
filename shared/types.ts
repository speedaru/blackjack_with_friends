// Message and table-state types used by both the server and the browser client.
// This file is the single place where the wire protocol is defined.

// ---------------------------------------------------------------- cards

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export interface Card {
  rank: Rank;
  suit: Suit;
}

/** A card as sent to clients. The dealer's hole card is `{ hidden: true }` until revealed. */
export type CardView = Card | { hidden: true };

export function isHiddenCard(card: CardView): card is { hidden: true } {
  return 'hidden' in card;
}

export const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

// ------------------------------------------------------------- settings

export type BlackjackPayout = '3:2' | '6:5';
export type DoubleRule = 'any' | '9-11' | 'off';

export interface Settings {
  maxPlayers: number;
  /** Empty string means no password. Never sent to clients. */
  password: string;
  startingChips: number;
  minBet: number;
  bettingSeconds: number;
  /** null turns the turn timer off. */
  turnSeconds: number | null;
  decks: number;
  dealerHitsSoft17: boolean;
  blackjackPayout: BlackjackPayout;
  doubleRule: DoubleRule;
  /** Whether a pair may be split into two hands. */
  splitAllowed: boolean;
}

/** Settings as sent to clients: the password itself is replaced by a flag. */
export type PublicSettings = Omit<Settings, 'password'> & { passwordSet: boolean };

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 6,
  password: '',
  startingChips: 1000,
  minBet: 10,
  bettingSeconds: 20,
  turnSeconds: 30,
  decks: 5,
  dealerHitsSoft17: false,
  blackjackPayout: '3:2',
  doubleRule: 'any',
  splitAllowed: true,
};

export const SETTINGS_LIMITS = {
  maxPlayers: { min: 1, max: 7 },
  startingChips: { min: 100, max: 100_000 },
  bettingSeconds: { min: 10, max: 60 },
  turnSeconds: { min: 10, max: 120 },
  decks: { min: 1, max: 8 },
} as const;

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

/** Returns an error message, or null when the whole settings object is valid. */
export function validateSettings(s: Settings): string | null {
  const L = SETTINGS_LIMITS;
  if (!isInt(s.maxPlayers) || s.maxPlayers < L.maxPlayers.min || s.maxPlayers > L.maxPlayers.max) {
    return `Max players must be ${L.maxPlayers.min} to ${L.maxPlayers.max}`;
  }
  if (typeof s.password !== 'string' || s.password.length > 100) return 'Password must be text of at most 100 characters';
  if (!isInt(s.startingChips) || s.startingChips < L.startingChips.min || s.startingChips > L.startingChips.max) {
    return `Starting chips must be ${L.startingChips.min} to ${L.startingChips.max}`;
  }
  if (!isInt(s.minBet) || s.minBet < 1) return 'Minimum bet must be at least 1';
  if (s.minBet > s.startingChips) return 'Minimum bet can not be more than the starting chips';
  if (!isInt(s.bettingSeconds) || s.bettingSeconds < L.bettingSeconds.min || s.bettingSeconds > L.bettingSeconds.max) {
    return `Betting timer must be ${L.bettingSeconds.min} to ${L.bettingSeconds.max} seconds`;
  }
  if (s.turnSeconds !== null) {
    if (!isInt(s.turnSeconds) || s.turnSeconds < L.turnSeconds.min || s.turnSeconds > L.turnSeconds.max) {
      return `Turn timer must be ${L.turnSeconds.min} to ${L.turnSeconds.max} seconds, or off`;
    }
  }
  if (!isInt(s.decks) || s.decks < L.decks.min || s.decks > L.decks.max) {
    return `Decks must be ${L.decks.min} to ${L.decks.max}`;
  }
  if (typeof s.dealerHitsSoft17 !== 'boolean') return 'Dealer on soft 17 must be stand or hit';
  if (s.blackjackPayout !== '3:2' && s.blackjackPayout !== '6:5') return 'Blackjack payout must be 3:2 or 6:5';
  if (s.doubleRule !== 'any' && s.doubleRule !== '9-11' && s.doubleRule !== 'off') {
    return 'Double down must be any, 9-11 or off';
  }
  if (typeof s.splitAllowed !== 'boolean') return 'Split must be on or off';
  return null;
}

// -------------------------------------------------------------- usernames

export const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,16}$/;

// ------------------------------------------------------------ table state

export type Phase = 'waiting' | 'betting' | 'dealing' | 'player_turns' | 'dealer_turn' | 'settle';

/** What happened to a hand once it has been settled. */
export type Outcome = 'win' | 'loss' | 'push' | 'blackjack';

export type HandStatus =
  | 'none' // no hand this round (sitting out, watching, or between rounds)
  | 'playing' // has cards, still to act or being acted on
  | 'stood'
  | 'bust'
  | 'blackjack';

/** One hand of a player. A player has one hand, or two after a split. */
export interface HandView {
  cards: Card[];
  bet: number;
  total: number;
  soft: boolean;
  status: HandStatus;
  doubled: boolean;
  /** True when the bet was the player's whole stack. */
  allIn: boolean;
  /** True for the two hands made by a split. A 21 on such a hand is not a blackjack. */
  fromSplit: boolean;
  /** True only for the hand being played right now, when the double rule and the chips allow it. */
  canDouble: boolean;
  /** Set once the round is settled; cleared when the next round starts. */
  outcome: Outcome | null;
  /** Net chip change for this hand, set together with `outcome`. */
  delta: number | null;
}

// ------------------------------------------------------------ side bets

/** `pairs` is Perfect Pairs (the first two cards), `plus3` is 21+3 (the first two cards and the dealer's up card). */
export type SideBetKind = 'pairs' | 'plus3';

export const SIDE_BET_KINDS: SideBetKind[] = ['pairs', 'plus3'];

export const SIDE_BET_NAMES: Record<SideBetKind, string> = { pairs: 'Perfect Pairs', plus3: '21+3' };

/**
 * Side bet amounts placed with the bet. A missing kind or 0 means no side bet; otherwise the amount is
 * a whole number from the minimum bet up to the main bet.
 */
export type SideBetChoice = Partial<Record<SideBetKind, number>>;

export interface SideBetView {
  kind: SideBetKind;
  bet: number;
  /** Name of the winning combination ("Perfect pair", "Flush"…), or null while unsettled or when it lost. */
  result: string | null;
  /** Net chip change, set once the side bet is settled right after the deal. */
  delta: number | null;
}

export interface PlayerView {
  id: string;
  name: string;
  chips: number;
  ready: boolean;
  connected: boolean;
  /**
   * Running result since the last reset. Losses and borrowing push it down, wins and withdrawals push it
   * up. Below 0 the player is in debt and can withdraw chips to bring it back up.
   */
  earnings: number;
  /** Seat index, or null when watching or waiting for a seat. */
  seat: number | null;
  /** Empty when the player has no hand (sitting out, watching, or between rounds). Two after a split. */
  hands: HandView[];
  /** Index into `hands` of the hand being played; 0 when it is nobody's turn. */
  activeHand: number;
  /** True only on this player's turn, when splitting is allowed right now. */
  canSplit: boolean;
  /** Side bets placed with this round's bet, settled right after the deal. Empty when none. */
  sideBets: SideBetView[];
}

export interface DealerView {
  /** The hole card is `{ hidden: true }` until it is revealed. */
  cards: CardView[];
  /** Total of the revealed cards only. */
  total: number;
  soft: boolean;
  blackjack: boolean;
}

export interface LogEntry {
  id: number;
  text: string;
}

export interface TableState {
  type: 'table_state';
  phase: Phase;
  /** True once the host has clicked Start. Settings are locked from then on. */
  started: boolean;
  settings: PublicSettings;
  hostId: string | null;
  players: PlayerView[];
  /** seats[i] is the player id sitting in seat i, or null. */
  seats: (string | null)[];
  dealer: DealerView;
  /** Id of the player whose turn it is, or null. */
  turn: string | null;
  /** Epoch ms when the current timer ends, or null when no timer runs. */
  deadline: number | null;
  /** Server clock when this state was sent, so clients can correct for clock differences. */
  serverNow: number;
  round: number;
  /** Goes up by one every time the shoe is reshuffled (not for the first shuffle). */
  shuffles: number;
  log: LogEntry[];
}

// ---------------------------------------------------------------- messages

export type ActionName = 'hit' | 'stand' | 'double' | 'split';

export type ClientMsg =
  | { type: 'join'; username: string; password?: string; reconnectToken?: string; hostToken?: string }
  | { type: 'leave' }
  | { type: 'set_ready'; ready: boolean }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'start_game' }
  | { type: 'place_bet'; amount: number; sideBets?: SideBetChoice }
  | { type: 'action'; action: ActionName }
  | { type: 'reset_chips' }
  | { type: 'borrow' }
  | { type: 'withdraw'; amount: number }
  | { type: 'kick_player'; playerId: string };

export type ErrorCode =
  | 'bad_message'
  | 'not_joined'
  | 'already_joined'
  | 'bad_username'
  | 'name_in_use'
  | 'wrong_password'
  | 'game_closed'
  | 'kicked'
  | 'wrong_phase'
  | 'not_your_turn'
  | 'not_host'
  | 'settings_locked'
  | 'invalid_settings'
  | 'cannot_start'
  | 'not_seated'
  | 'bet_invalid'
  | 'already_bet'
  | 'insufficient_chips'
  | 'action_not_allowed'
  | 'unknown_player'
  | 'cannot_reset'
  | 'cannot_borrow'
  | 'cannot_withdraw';

export interface RoundResultEntry {
  playerId: string;
  name: string;
  /** Which of the player's hands this result is for (0 unless they split). */
  hand: number;
  outcome: Outcome;
  delta: number;
}

export type ServerMsg =
  | { type: 'server_info'; passwordRequired: boolean; seatsFree: boolean; phase: Phase; gameOpen: boolean }
  | { type: 'joined'; playerId: string; reconnectToken: string; isHost: boolean }
  | TableState
  | { type: 'round_result'; round: number; results: RoundResultEntry[] }
  | { type: 'kicked'; reason: string }
  | { type: 'error'; code: ErrorCode; message: string };
