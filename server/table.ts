// The one table: players, seats, settings, round flow and timers.
// It talks to clients only through the small `Connection` interface, and all card rules live in game.ts.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  USERNAME_PATTERN,
  validateSettings,
  type ActionName,
  type Card,
  type CardView,
  type ClientMsg,
  type DealerView,
  type ErrorCode,
  type HandStatus,
  type HandView,
  type LogEntry,
  type Outcome,
  type Phase,
  type PlayerView,
  type PublicSettings,
  type RoundResultEntry,
  type ServerMsg,
  type Settings,
  type SideBetKind,
  type TableState,
  SIDE_BET_KINDS,
  SIDE_BET_NAMES,
} from '../shared/types.js';
import { evaluateSideBet } from './sidebets.js';
import { Shoe, mulberry32, randomSeed } from './deck.js';
import {
  canDouble,
  canSplit,
  dealerShouldHit,
  handValue,
  isBlackjack,
  isTenValue,
  settleHand,
} from './game.js';
import type { PlayerStore } from './store.js';

/** One client connection. The WebSocket layer implements this; tests can use a fake. */
export interface Connection {
  send(msg: ServerMsg): void;
  close(): void;
}

export interface Timing {
  /** Gap between dealt cards. */
  dealMs: number;
  /** Pause before the dealer reveals and between dealer draws. */
  dealerStepMs: number;
  /** How long round results stay on screen. */
  settleMs: number;
  /** How long a disconnected player's seat is held. */
  holdMs: number;
  /** Test override for the betting timer; the setting is used when absent. */
  bettingMs?: number;
  /** Test override for the turn timer; ignored when the host turned the turn timer off. */
  turnMs?: number;
}

/** How long results stay on screen before the next betting phase starts. */
export const ROUND_PAUSE_MS = 2000;

export const DEFAULT_TIMING: Timing = {
  dealMs: 300,
  dealerStepMs: 800,
  settleMs: ROUND_PAUSE_MS,
  holdMs: 20_000,
};

export interface TableOptions {
  store: PlayerStore;
  hostToken: string;
  timing?: Partial<Timing>;
  /** Seed for the shoe shuffle. Random when absent. */
  seed?: number;
  /** Cards dealt first, in order. For tests only. */
  rigged?: Card[];
  log?: (message: string) => void;
}

/** One hand of a round. A player has one hand, or two after a split. */
interface Hand {
  cards: Card[];
  bet: number;
  status: HandStatus;
  doubled: boolean;
  allIn: boolean;
  fromSplit: boolean;
  outcome: Outcome | null;
  delta: number | null;
}

function newHand(bet: number, allIn = false): Hand {
  return { cards: [], bet, status: 'none', doubled: false, allIn, fromSplit: false, outcome: null, delta: null };
}

/** Whether the player has placed a bet for the coming round. */
function hasBet(p: { hands: Hand[] }): boolean {
  return (p.hands[0]?.bet ?? 0) > 0;
}

interface Player {
  id: string;
  name: string;
  key: string;
  token: string;
  chips: number;
  /**
   * How far ahead (or behind) the player is. Goes down with losses and with borrowing, and back up with
   * wins and withdrawals, so a negative number is what the player owes. Saved with the chips.
   * Reset to 0 by Reset chips.
   */
  earnings: number;
  ready: boolean;
  seat: number | null;
  conn: Connection | null;
  holdTimer: NodeJS.Timeout | null;
  /** Set when the player left, was kicked, or lost the seat hold while a hand is live. Removed after the round. */
  leaving: boolean;
  /** Empty until the player bets. The bet is hands[0].bet during betting; a split adds a second hand. */
  hands: Hand[];
  /** Index of the hand being played. */
  activeHand: number;
  inRound: boolean;
  /** Side bets placed with the bet. Their stakes are taken with the bet and paid right after the deal. */
  sideBets: SideBet[];
}

interface SideBet {
  kind: SideBetKind;
  bet: number;
  result: string | null;
  delta: number | null;
}

const LOG_LIMIT = 30;
const MAX_NAME_LEN = 16;

function rankText(card: Card): string {
  return card.rank;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class Table {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private phase: Phase = 'waiting';
  private started = false;
  private round = 0;
  private hostId: string | null = null;
  private readonly players = new Map<string, Player>();
  private seats: (string | null)[] = Array(DEFAULT_SETTINGS.maxPlayers).fill(null);
  private readonly connections = new Set<Connection>();
  private readonly bound = new Map<Connection, string>();
  private readonly kickedKeys = new Set<string>();
  private dealerCards: Card[] = [];
  private dealerRevealed = false;
  private turn: string | null = null;
  private deadline: number | null = null;
  private shoe: Shoe | null = null;
  private flow: NodeJS.Timeout | null = null;
  private logEntries: LogEntry[] = [];
  private logId = 0;
  private noBetsLogged = false;
  /** Counts reshuffles, so clients can play a sound when it goes up. */
  private shuffles = 0;
  private closed = false;
  /** False after the last player left: only the host link can open a new game. */
  private gameOpen = true;

  private readonly store: PlayerStore;
  private readonly hostToken: string;
  private readonly timing: Timing;
  private readonly rng: () => number;
  private readonly rigged: Card[];
  private readonly logger: (message: string) => void;

  constructor(options: TableOptions) {
    this.store = options.store;
    this.hostToken = options.hostToken;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.rng = mulberry32(options.seed ?? randomSeed());
    this.rigged = options.rigged ?? [];
    this.logger = options.log ?? ((m) => console.error(m));
  }

  // ------------------------------------------------------------ connections

  connect(conn: Connection): void {
    if (this.closed) {
      conn.close();
      return;
    }
    this.connections.add(conn);
    conn.send(this.serverInfo());
  }

  disconnect(conn: Connection): void {
    this.connections.delete(conn);
    const id = this.bound.get(conn);
    this.bound.delete(conn);
    if (!id) return;
    const p = this.players.get(id);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    this.addLog(`${p.name} disconnected`);
    this.startHold(p);
    // With the turn timer off, a disconnected player must not freeze the table.
    if (this.turn === p.id && this.settings.turnSeconds === null && this.flow === null) {
      this.armTurnTimer(p);
    }
    this.broadcast();
    this.checkBettingDone();
  }

  /** Stops all timers. Connections are closed by the caller. */
  close(): void {
    this.closed = true;
    this.clearFlow();
    for (const p of this.players.values()) this.clearHold(p);
  }

  // --------------------------------------------------------------- messages

  handleMessage(conn: Connection, raw: string): void {
    if (this.closed) return;
    try {
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        this.sendError(conn, 'bad_message', 'Messages must be JSON');
        return;
      }
      if (msg === null || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
        this.sendError(conn, 'bad_message', 'Message needs a type');
        return;
      }
      this.dispatch(conn, msg as ClientMsg);
    } catch (err) {
      // No single message may take the server down.
      this.logger(`Error handling message: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      this.sendError(conn, 'bad_message', 'The server could not handle that message');
    }
  }

  private dispatch(conn: Connection, msg: ClientMsg): void {
    if (msg.type === 'join') return this.onJoin(conn, msg);

    const p = this.playerOf(conn);
    if (!p) return this.sendError(conn, 'not_joined', 'Join the table first');

    switch (msg.type) {
      case 'leave':
        return this.onLeave(conn, p);
      case 'set_ready':
        return this.onSetReady(conn, p, msg.ready);
      case 'update_settings':
        return this.onUpdateSettings(conn, p, msg.settings);
      case 'start_game':
        return this.onStartGame(conn, p);
      case 'place_bet':
        return this.onPlaceBet(conn, p, msg.amount, msg.sideBets);
      case 'action':
        return this.onAction(conn, p, msg.action);
      case 'reset_chips':
        return this.onResetChips(conn, p);
      case 'borrow':
        return this.onBorrow(conn, p);
      case 'withdraw':
        return this.onWithdraw(conn, p, msg.amount);
      case 'kick_player':
        return this.onKick(conn, p, msg.playerId);
      default:
        return this.sendError(conn, 'bad_message', 'Unknown message type');
    }
  }

  // ------------------------------------------------------------------- join

  private onJoin(conn: Connection, msg: Extract<ClientMsg, { type: 'join' }>): void {
    if (this.bound.has(conn)) return this.sendError(conn, 'already_joined', 'You have already joined');

    if (typeof msg.username !== 'string') return this.sendError(conn, 'bad_username', 'Enter a username');
    const username = msg.username.trim();
    if (username.length < 1 || username.length > MAX_NAME_LEN || !USERNAME_PATTERN.test(username)) {
      return this.sendError(
        conn,
        'bad_username',
        'Usernames are 1 to 16 characters: letters, numbers, spaces, - and _',
      );
    }
    const key = username.toLowerCase();

    const asHost =
      typeof msg.hostToken === 'string' && msg.hostToken.length > 0 && safeEqual(msg.hostToken, this.hostToken);

    if (!this.gameOpen) {
      if (!asHost) {
        return this.sendError(conn, 'game_closed', 'This game has ended. Ask the host to create a new game.');
      }
      this.openGame(conn);
    }

    if (this.kickedKeys.has(key)) {
      return this.sendError(conn, 'kicked', 'You were kicked from this table and can not rejoin until the server restarts');
    }

    const existing = [...this.players.values()].find((x) => x.key === key);
    if (existing) {
      const tokenOk =
        typeof msg.reconnectToken === 'string' && existing.token !== '' && safeEqual(msg.reconnectToken, existing.token);
      if (!tokenOk) return this.sendError(conn, 'name_in_use', 'That name is in use');
      return this.reconnect(conn, existing, asHost);
    }

    if (this.settings.password !== '') {
      const given = typeof msg.password === 'string' ? msg.password : '';
      if (!safeEqual(given, this.settings.password)) return this.sendError(conn, 'wrong_password', 'Wrong password');
    }

    const saved = this.store.get(username);
    const name = saved?.name ?? username;
    const chips = saved ? saved.chips : this.settings.startingChips;
    const earnings = saved ? saved.earnings : 0;
    if (!saved) this.store.set(name, chips);

    const p: Player = {
      id: randomBytes(6).toString('hex'),
      name,
      key,
      token: randomBytes(16).toString('hex'),
      chips,
      earnings,
      ready: false,
      seat: null,
      conn,
      holdTimer: null,
      leaving: false,
      hands: [],
      activeHand: 0,
      inRound: false,
      sideBets: [],
    };
    this.players.set(p.id, p);
    this.bound.set(conn, p.id);
    if (asHost) this.hostId = p.id;

    this.addLog(`${p.name} joined`);
    conn.send({ type: 'joined', playerId: p.id, reconnectToken: p.token, isHost: this.hostId === p.id });

    // A table that went idle because it was empty starts a betting phase for the newcomer.
    if (this.started && this.phase === 'betting' && this.deadline === null) {
      this.beginBetting();
    } else {
      this.broadcast();
    }
  }

  private reconnect(conn: Connection, p: Player, asHost: boolean): void {
    if (p.conn && p.conn !== conn) {
      this.bound.delete(p.conn);
      p.conn.send({ type: 'error', code: 'already_joined', message: 'This player was opened in another tab' });
      p.conn.close();
    }
    p.conn = conn;
    p.leaving = false;
    this.clearHold(p);
    this.bound.set(conn, p.id);
    if (asHost) this.hostId = p.id;
    this.addLog(`${p.name} reconnected`);
    conn.send({ type: 'joined', playerId: p.id, reconnectToken: p.token, isHost: this.hostId === p.id });
    // With the turn timer off, the fallback timer for an absent player is no longer needed.
    if (this.turn === p.id && this.settings.turnSeconds === null) {
      this.clearFlow();
      this.deadline = null;
    }
    this.broadcast();
  }

  // --------------------------------------------------------- leave and drop

  private onLeave(conn: Connection, p: Player): void {
    this.bound.delete(conn);
    p.conn = null;
    p.token = ''; // an explicit leave can not be undone with the old token
    this.addLog(`${p.name} left`);
    this.dropPlayer(p);
    conn.send(this.serverInfo());
  }

  private startHold(p: Player): void {
    this.clearHold(p);
    p.holdTimer = setTimeout(() => {
      p.holdTimer = null;
      if (this.closed || p.conn) return;
      this.addLog(`${p.name} did not come back`);
      this.dropPlayer(p);
    }, this.timing.holdMs);
  }

  private clearHold(p: Player): void {
    if (p.holdTimer) clearTimeout(p.holdTimer);
    p.holdTimer = null;
  }

  private handIsLive(p: Player): boolean {
    return p.inRound && (this.phase === 'dealing' || this.phase === 'player_turns' || this.phase === 'dealer_turn');
  }

  /** Removes a player now, or marks them to be removed after the round when their hand is still live. */
  private dropPlayer(p: Player): void {
    this.clearHold(p);
    if (this.handIsLive(p)) {
      p.leaving = true;
      if (this.turn === p.id) this.autoStand(p, 'left the table');
      else this.broadcast();
      return;
    }
    this.removePlayer(p);
  }

  private removePlayer(p: Player): void {
    // A bet placed for a round that has not been dealt is given back.
    if (this.phase === 'betting' && hasBet(p)) {
      p.chips += p.hands[0]!.bet + p.sideBets.reduce((sum, sb) => sum + sb.bet, 0);
      p.hands = [];
      p.sideBets = [];
    }
    this.store.set(p.name, p.chips, p.earnings);
    this.store.save();
    this.clearHold(p);
    if (p.seat !== null) this.seats[p.seat] = null;
    this.players.delete(p.id);
    if (p.conn) {
      this.bound.delete(p.conn);
      p.conn = null;
    }
    if (this.hostId === p.id) this.hostId = null;
    if (this.players.size === 0) {
      this.endGame();
      return;
    }
    this.broadcast();
    this.checkBettingDone();
  }

  /** The last player left: forget this game completely. A new one needs the host link. */
  private endGame(): void {
    this.clearFlow();
    this.gameOpen = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'waiting';
    this.started = false;
    this.round = 0;
    this.hostId = null;
    this.seats = Array(DEFAULT_SETTINGS.maxPlayers).fill(null);
    this.kickedKeys.clear();
    this.dealerCards = [];
    this.dealerRevealed = false;
    this.turn = null;
    this.deadline = null;
    this.shoe = null;
    this.logEntries = [];
    this.noBetsLogged = false;
    this.shuffles = 0;
    this.tellUnjoined();
  }

  /** The host created a new game. Everyone still on the join screen is told it is open again. */
  private openGame(except: Connection): void {
    this.gameOpen = true;
    this.tellUnjoined(except);
  }

  private tellUnjoined(except?: Connection): void {
    for (const c of this.connections) {
      if (c === except || this.bound.has(c)) continue;
      try {
        c.send(this.serverInfo());
      } catch (err) {
        this.logger(`Could not send to a client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------- waiting

  private onSetReady(conn: Connection, p: Player, ready: unknown): void {
    if (this.phase !== 'waiting') return this.sendError(conn, 'wrong_phase', 'Ready only applies in the waiting room');
    if (typeof ready !== 'boolean') return this.sendError(conn, 'bad_message', 'ready must be true or false');
    p.ready = ready;
    this.broadcast();
  }

  private onUpdateSettings(conn: Connection, p: Player, patch: unknown): void {
    if (this.hostId !== p.id) return this.sendError(conn, 'not_host', 'Only the host can change settings');
    if (this.started || this.phase !== 'waiting') {
      return this.sendError(conn, 'settings_locked', 'Settings are locked once the game has started');
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return this.sendError(conn, 'invalid_settings', 'Settings must be an object');
    }
    const next: Settings = { ...this.settings };
    const input = patch as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (key in input) (next as unknown as Record<string, unknown>)[key] = input[key];
    }
    const problem = validateSettings(next);
    if (problem) return this.sendError(conn, 'invalid_settings', problem);
    if (next.maxPlayers < this.players.size) {
      return this.sendError(conn, 'invalid_settings', 'Max players can not be lower than the players already here');
    }
    this.settings = next;
    this.seats = Array(next.maxPlayers).fill(null);
    this.broadcast();
  }

  private onStartGame(conn: Connection, p: Player): void {
    if (this.hostId !== p.id) return this.sendError(conn, 'not_host', 'Only the host can start the game');
    if (this.started || this.phase !== 'waiting') return this.sendError(conn, 'wrong_phase', 'The game has already started');
    if (![...this.players.values()].some((x) => x.ready)) {
      return this.sendError(conn, 'cannot_start', 'At least one player must be ready');
    }
    this.started = true;
    this.shoe = new Shoe(this.settings.decks, this.rng, this.rigged);
    this.addLog('The game has started');
    this.beginBetting();
  }

  // ---------------------------------------------------------------- betting

  private resetHand(p: Player): void {
    p.hands = [];
    p.activeHand = 0;
    p.inRound = false;
    p.sideBets = [];
  }

  private assignSeats(): void {
    for (const p of this.players.values()) {
      if (p.seat !== null || p.leaving) continue;
      const free = this.seats.findIndex((s) => s === null);
      if (free < 0) break;
      this.seats[free] = p.id;
      p.seat = free;
    }
  }

  private seatedInOrder(): Player[] {
    return this.seats
      .map((id) => (id ? this.players.get(id) : undefined))
      .filter((p): p is Player => p !== undefined);
  }

  private beginBetting(): void {
    this.clearFlow();
    this.phase = 'betting';
    this.turn = null;
    this.deadline = null;
    for (const p of this.players.values()) this.resetHand(p);
    this.dealerCards = [];
    this.dealerRevealed = false;

    if (this.shoe && this.shoe.needsReshuffle()) {
      this.shoe.shuffle();
      this.shuffles++;
      this.addLog('Shuffling a new shoe');
    }
    this.assignSeats();

    if (this.players.size === 0) {
      this.broadcast(); // idle until someone joins
      return;
    }
    const ms = this.bettingMs();
    this.deadline = Date.now() + ms;
    if (!this.noBetsLogged) this.addLog(`Round ${this.round + 1}: place your bets`);
    this.setFlow(() => this.endBetting(), ms);
    this.broadcast();
  }

  private bettingMs(): number {
    return this.timing.bettingMs ?? this.settings.bettingSeconds * 1000;
  }

  private canBet(p: Player): boolean {
    return p.seat !== null && !p.leaving && p.conn !== null && p.chips >= this.settings.minBet;
  }

  /** Ends the betting phase early once every player who is able to bet has bet. */
  private checkBettingDone(): void {
    if (this.phase !== 'betting' || this.deadline === null) return;
    const able = this.seatedInOrder().filter((p) => this.canBet(p) || hasBet(p));
    if (able.length > 0 && able.every((p) => hasBet(p))) this.endBetting();
  }

  private onPlaceBet(conn: Connection, p: Player, amount: unknown, sideBets: unknown): void {
    if (this.phase !== 'betting' || this.deadline === null) {
      return this.sendError(conn, 'wrong_phase', 'Bets are only taken during the betting phase');
    }
    if (p.seat === null) return this.sendError(conn, 'not_seated', 'You do not have a seat yet');
    if (hasBet(p)) return this.sendError(conn, 'already_bet', 'You have already bet this round');
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      return this.sendError(conn, 'bet_invalid', 'A bet must be a whole number');
    }
    const { minBet } = this.settings;
    if (amount < minBet) {
      return this.sendError(conn, 'bet_invalid', `The minimum bet is ${minBet}`);
    }
    if (sideBets !== undefined && (typeof sideBets !== 'object' || sideBets === null || Array.isArray(sideBets))) {
      return this.sendError(conn, 'bet_invalid', 'Side bets must be an object');
    }
    const choice = (sideBets ?? {}) as Record<string, unknown>;
    // Each side bet is 0 (none) or a whole number from the minimum bet up to the main bet.
    const placed: SideBet[] = [];
    for (const kind of SIDE_BET_KINDS) {
      const v = choice[kind];
      if (v === undefined || v === 0) continue;
      const name = SIDE_BET_NAMES[kind];
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        return this.sendError(conn, 'bet_invalid', `The ${name} side bet must be a whole number`);
      }
      if (v < minBet || v > amount) {
        return this.sendError(conn, 'bet_invalid', `The ${name} side bet must be from ${minBet} up to your bet`);
      }
      placed.push({ kind, bet: v, result: null, delta: null });
    }
    const total = amount + placed.reduce((sum, sb) => sum + sb.bet, 0);
    if (total > p.chips) return this.sendError(conn, 'insufficient_chips', 'You do not have enough chips');
    const allIn = total === p.chips;
    p.chips -= total;
    p.hands = [newHand(amount, allIn)];
    p.sideBets = placed;
    const sides =
      placed.length > 0 ? ` + ${placed.map((sb) => `${SIDE_BET_NAMES[sb.kind]} ${sb.bet.toLocaleString('en-US')}`).join(' and ')}` : '';
    this.addLog(
      allIn ? `${p.name} goes all in (${total.toLocaleString('en-US')})${sides}` : `${p.name} bets ${amount}${sides}`,
    );
    this.broadcast();
    this.checkBettingDone();
  }

  private onResetChips(conn: Connection, p: Player): void {
    const ok = this.phase === 'waiting' || (this.phase === 'betting' && !hasBet(p));
    if (!ok) {
      return this.sendError(conn, 'cannot_reset', 'Chips can only be reset in the waiting room or before you bet');
    }
    p.chips = this.settings.startingChips;
    p.earnings = 0; // a reset is a fresh start, so the earnings (and what was owed) are wiped too
    this.store.set(p.name, p.chips, p.earnings);
    this.store.save();
    this.addLog(`${p.name} reset their chips to ${p.chips}`);
    this.broadcast();
  }

  /**
   * Takes chips out of the player's balance to pay down what they owe: the earnings go up by the same
   * amount. Only possible while the earnings are negative, and never for more than the debt or the chips.
   */
  private onWithdraw(conn: Connection, p: Player, amount: number): void {
    const ok = this.phase === 'waiting' || (this.phase === 'betting' && !hasBet(p));
    if (!ok) return this.sendError(conn, 'cannot_withdraw', 'You can only withdraw in the waiting room or before you bet');
    if (p.earnings >= 0) return this.sendError(conn, 'cannot_withdraw', 'You are not in debt');
    if (p.chips <= 0) return this.sendError(conn, 'cannot_withdraw', 'You have no chips to withdraw');
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
      return this.sendError(conn, 'cannot_withdraw', 'A withdrawal must be a whole number of chips');
    }
    const max = Math.min(p.chips, -p.earnings);
    if (amount > max) return this.sendError(conn, 'cannot_withdraw', `You can withdraw at most ${max.toLocaleString('en-US')}`);
    p.chips -= amount;
    p.earnings += amount;
    this.store.set(p.name, p.chips, p.earnings);
    this.store.save();
    this.addLog(`${p.name} withdraws ${amount.toLocaleString('en-US')}`);
    this.broadcast();
    this.checkBettingDone(); // withdrawing can leave the player without chips to bet
  }

  /**
   * A player who is out of chips borrows a buy-in (the starting chips). The earnings drop to at most
   * minus the buy-in, so borrowed chips are always owed: earnings already below that stay as they are.
   */
  private onBorrow(conn: Connection, p: Player): void {
    if (this.phase !== 'betting' || this.deadline === null) {
      return this.sendError(conn, 'cannot_borrow', 'You can only borrow chips while bets are being placed');
    }
    if (p.seat === null) return this.sendError(conn, 'not_seated', 'You do not have a seat yet');
    if (hasBet(p) || p.chips >= this.settings.minBet) {
      return this.sendError(conn, 'cannot_borrow', 'You can only borrow when you are out of chips');
    }
    const amount = this.settings.startingChips;
    p.chips += amount;
    p.earnings = Math.min(p.earnings, -amount);
    this.store.set(p.name, p.chips, p.earnings);
    this.store.save();
    this.addLog(`${p.name} borrows ${amount.toLocaleString('en-US')}`);
    this.broadcast();
  }

  private endBetting(): void {
    this.clearFlow();
    const active = this.seatedInOrder().filter((p) => hasBet(p));
    if (active.length === 0) {
      if (!this.noBetsLogged) this.addLog('No bets were placed');
      this.noBetsLogged = true;
      this.beginBetting();
      return;
    }
    this.noBetsLogged = false;
    this.startDeal(active);
  }

  // ------------------------------------------------------------------- deal

  private cardsOnTable(): Card[] {
    const cards = [...this.dealerCards];
    for (const p of this.players.values()) for (const hd of p.hands) cards.push(...hd.cards);
    return cards;
  }

  private drawCard(): Card {
    const shoe = this.shoe!;
    const card = shoe.draw(this.cardsOnTable());
    if (shoe.autoReshuffled) {
      shoe.autoReshuffled = false;
      this.shuffles++;
      this.addLog('The shoe ran out, shuffling a new one');
    }
    return card;
  }

  private startDeal(active: Player[]): void {
    this.phase = 'dealing';
    this.deadline = null;
    this.turn = null;
    this.round++;
    for (const p of this.players.values()) {
      p.inRound = hasBet(p);
      for (const hd of p.hands) hd.status = 'playing';
    }
    const dealPlayer = (p: Player) => () => p.hands[0]!.cards.push(this.drawCard());
    const dealDealer = () => this.dealerCards.push(this.drawCard());
    const steps = [
      ...active.map(dealPlayer),
      dealDealer, // up card
      ...active.map(dealPlayer),
      dealDealer, // hole card, face down
    ];
    this.runDealSteps(steps, active, 0);
  }

  private runDealSteps(steps: (() => void)[], active: Player[], i: number): void {
    if (i >= steps.length) return this.afterDeal(active);
    steps[i]!();
    this.broadcast();
    this.setFlow(() => this.runDealSteps(steps, active, i + 1), this.timing.dealMs);
  }

  /** Pays or takes every side bet. They only need the first two cards and the dealer's up card. */
  private settleSideBets(active: Player[]): void {
    const up = this.dealerCards[0]!;
    for (const p of active) {
      for (const sb of p.sideBets) {
        const win = evaluateSideBet(sb.kind, p.hands[0]!.cards, up);
        sb.delta = win ? sb.bet * win.multiplier : -sb.bet;
        sb.result = win ? win.name : null;
        // The stake was taken with the bet, so a win gives the stake back with the winnings.
        if (win) p.chips += sb.bet + sb.delta;
        p.earnings += sb.delta;
        const name = SIDE_BET_NAMES[sb.kind];
        this.addLog(win ? `${p.name}: ${win.name} on ${name}, +${sb.delta.toLocaleString('en-US')}` : `${p.name} loses ${name}`);
      }
    }
    if (active.some((p) => p.sideBets.length > 0)) {
      for (const p of active) this.store.set(p.name, p.chips, p.earnings);
      this.store.save();
    }
  }

  private afterDeal(active: Player[]): void {
    this.settleSideBets(active);
    for (const p of active) {
      if (isBlackjack(p.hands[0]!.cards)) {
        p.hands[0]!.status = 'blackjack';
        this.addLog(`${p.name} has blackjack`);
      }
    }
    const up = this.dealerCards[0]!;
    if (up.rank === 'A' || isTenValue(up)) {
      if (isBlackjack(this.dealerCards)) {
        this.phase = 'dealer_turn';
        this.dealerRevealed = true;
        this.addLog('Dealer has blackjack');
        this.broadcast();
        this.setFlow(() => this.settle(), this.timing.dealerStepMs);
        return;
      }
      this.addLog('Dealer checks the hole card: no blackjack');
    }
    this.phase = 'player_turns';
    this.advanceTurn();
  }

  // ------------------------------------------------------------ player turns

  private activePlayers(): Player[] {
    return this.seatedInOrder().filter((p) => p.inRound);
  }

  private advanceTurn(): void {
    const next = this.activePlayers().find((p) => p.hands.some((hd) => hd.status === 'playing'));
    if (!next) {
      this.turn = null;
      this.deadline = null;
      this.dealerTurn();
      return;
    }
    this.turn = next.id;
    next.activeHand = next.hands.findIndex((hd) => hd.status === 'playing');
    if (next.leaving) return this.autoStand(next, 'left the table');
    this.armTurnTimer(next);
    this.broadcast();
  }

  /** Starts (or restarts) the timer for the current player's turn. */
  private armTurnTimer(p: Player): void {
    this.clearFlow();
    let ms: number | null = null;
    if (this.settings.turnSeconds !== null) ms = this.timing.turnMs ?? this.settings.turnSeconds * 1000;
    // With the turn timer off, an absent player still must not hold up the table.
    else if (p.conn === null) ms = this.timing.holdMs;
    if (ms === null) {
      this.deadline = null;
      return;
    }
    this.deadline = Date.now() + ms;
    this.setFlow(() => this.autoStand(p, p.conn === null ? 'is away' : 'ran out of time'), ms);
  }

  private autoStand(p: Player, reason: string): void {
    const hand = p.hands[p.activeHand];
    if (this.turn !== p.id || !hand || hand.status !== 'playing') return;
    hand.status = 'stood';
    this.addLog(`${this.who(p)} ${reason} and stands on ${handValue(hand.cards).total}`);
    this.advanceTurn();
  }

  /** The player's name, plus which hand when they have split. */
  private who(p: Player): string {
    return p.hands.length > 1 ? `${p.name} (hand ${p.activeHand + 1})` : p.name;
  }

  private onAction(conn: Connection, p: Player, action: unknown): void {
    if (this.phase !== 'player_turns') {
      return this.sendError(conn, 'wrong_phase', 'Actions are only allowed during player turns');
    }
    if (this.turn !== p.id) return this.sendError(conn, 'not_your_turn', 'It is not your turn');
    if (action !== 'hit' && action !== 'stand' && action !== 'double' && action !== 'split') {
      return this.sendError(conn, 'bad_message', 'Action must be hit, stand, double or split');
    }
    this.act(conn, p, action);
  }

  private act(conn: Connection, p: Player, action: ActionName): void {
    const hand = p.hands[p.activeHand];
    if (!hand || hand.status !== 'playing') return this.sendError(conn, 'action_not_allowed', 'You have no hand to play');
    const who = this.who(p);

    if (action === 'stand') {
      hand.status = 'stood';
      this.addLog(`${who} stands on ${handValue(hand.cards).total}`);
      return this.advanceTurn();
    }

    if (action === 'split') return this.split(conn, p, hand);

    if (action === 'double') {
      if (!canDouble(hand.cards, this.settings.doubleRule, p.chips, hand.bet, hand.fromSplit)) {
        return this.sendError(conn, 'action_not_allowed', 'You can not double right now');
      }
      p.chips -= hand.bet;
      hand.bet *= 2;
      hand.doubled = true;
      const card = this.drawCard();
      hand.cards.push(card);
      const { total } = handValue(hand.cards);
      this.addLog(`${who} doubles: ${rankText(card)}, total ${total}`);
      if (total > 21) {
        hand.status = 'bust';
        this.addLog(`${who} busts`);
      } else {
        hand.status = 'stood';
      }
      return this.advanceTurn();
    }

    // hit
    const card = this.drawCard();
    hand.cards.push(card);
    const { total } = handValue(hand.cards);
    this.addLog(`${who} hits: ${rankText(card)}, total ${total}`);
    if (total > 21) {
      hand.status = 'bust';
      this.addLog(`${who} busts`);
      return this.advanceTurn();
    }
    if (total === 21) {
      hand.status = 'stood';
      return this.advanceTurn();
    }
    this.armTurnTimer(p); // every decision gets a fresh timer
    this.broadcast();
  }

  /** Splits a pair into two hands, each with a second card. Only one split per round, no re-splitting. */
  private split(conn: Connection, p: Player, hand: Hand): void {
    if (!canSplit(hand.cards, this.settings.splitAllowed, p.chips, hand.bet, p.hands.length > 1)) {
      return this.sendError(conn, 'action_not_allowed', 'You can not split right now');
    }
    const [first, second] = hand.cards as [Card, Card];
    p.chips -= hand.bet;
    const right = newHand(hand.bet);
    hand.cards = [first];
    hand.fromSplit = true;
    right.cards = [second];
    right.fromSplit = true;
    right.status = 'playing';
    p.hands.push(right);
    this.addLog(`${p.name} splits ${rankText(first)}s`);

    // The left hand gets its card first, then the right hand.
    for (const hd of p.hands) hd.cards.push(this.drawCard());
    const acesSplit = first.rank === 'A';
    p.hands.forEach((hd, i) => {
      const { total } = handValue(hd.cards);
      this.addLog(`${p.name} (hand ${i + 1}): ${hd.cards.map(rankText).join(' ')}, total ${total}`);
      // Split aces get exactly one card each and stand. A 21 is a normal 21 and stands too.
      if (acesSplit || total === 21) hd.status = 'stood';
    });
    this.advanceTurn(); // the left hand if it is still playing, else the right hand, else the next player
  }

  // ------------------------------------------------------------ dealer turn

  private dealerTurn(): void {
    this.phase = 'dealer_turn';
    this.dealerRevealed = true;
    const hole = this.dealerCards[1]!;
    this.addLog(`Dealer reveals ${rankText(hole)}, total ${handValue(this.dealerCards).total}`);
    this.broadcast();

    // If every player busted or has blackjack, there is nothing left to beat.
    const needsDraw = this.activePlayers().some((p) => p.hands.some((hd) => hd.status === 'stood'));
    const step = () => {
      if (needsDraw && dealerShouldHit(this.dealerCards, this.settings.dealerHitsSoft17)) {
        const card = this.drawCard();
        this.dealerCards.push(card);
        this.addLog(`Dealer draws ${rankText(card)}, total ${handValue(this.dealerCards).total}`);
        this.broadcast();
        this.setFlow(step, this.timing.dealerStepMs);
      } else {
        const { total } = handValue(this.dealerCards);
        this.addLog(total > 21 ? `Dealer busts with ${total}` : `Dealer stands on ${total}`);
        this.settle();
      }
    };
    this.setFlow(step, this.timing.dealerStepMs);
  }

  // ----------------------------------------------------------------- settle

  private settle(): void {
    this.clearFlow();
    this.phase = 'settle';
    this.turn = null;
    this.deadline = null;
    this.dealerRevealed = true;

    const results: RoundResultEntry[] = [];
    for (const p of this.activePlayers()) {
      p.hands.forEach((hd, i) => {
        if (hd.status === 'playing') hd.status = 'stood';
        const r = settleHand(hd.cards, this.dealerCards, hd.bet, this.settings.blackjackPayout, hd.fromSplit);
        // The bet was taken when it was placed, so the bet and the winnings come back together.
        p.chips += hd.bet + r.delta;
        p.earnings += r.delta;
        hd.outcome = r.outcome;
        hd.delta = r.delta;
        results.push({ playerId: p.id, name: p.name, hand: i, outcome: r.outcome, delta: r.delta });
        const name = p.hands.length > 1 ? `${p.name} (hand ${i + 1})` : p.name;
        this.addLog(`${name} ${describeOutcome(r.outcome, r.delta)}`);
      });
    }
    for (const p of this.players.values()) this.store.set(p.name, p.chips, p.earnings);
    this.store.save();

    this.broadcast();
    this.send({ type: 'round_result', round: this.round, results });
    this.setFlow(() => this.nextRound(), this.timing.settleMs);
  }

  private nextRound(): void {
    for (const p of [...this.players.values()]) {
      if (p.leaving) this.removePlayer(p);
    }
    if (!this.gameOpen) return; // the last player left, so the game ended
    this.beginBetting();
  }

  // ------------------------------------------------------------------- kick

  private onKick(conn: Connection, p: Player, targetId: unknown): void {
    if (this.hostId !== p.id) return this.sendError(conn, 'not_host', 'Only the host can kick players');
    if (typeof targetId !== 'string') return this.sendError(conn, 'bad_message', 'playerId must be text');
    const target = this.players.get(targetId);
    if (!target) return this.sendError(conn, 'unknown_player', 'That player is not at the table');
    if (target.id === p.id) return this.sendError(conn, 'bad_message', 'You can not kick yourself');

    this.kickedKeys.add(target.key);
    target.token = '';
    this.addLog(`${target.name} was kicked`);
    const tconn = target.conn;
    if (tconn) {
      tconn.send({ type: 'kicked', reason: 'The host kicked you from the table' });
      this.bound.delete(tconn);
      target.conn = null;
      tconn.close();
    }
    this.dropPlayer(target);
  }

  // ----------------------------------------------------------------- output

  private serverInfo(): ServerMsg {
    const holders = this.started ? this.seats.filter((s) => s !== null).length : this.players.size;
    const queued = this.started ? [...this.players.values()].filter((p) => p.seat === null && !p.leaving).length : 0;
    return {
      type: 'server_info',
      passwordRequired: this.settings.password !== '',
      seatsFree: holders + queued < this.settings.maxPlayers,
      phase: this.phase,
      gameOpen: this.gameOpen,
    };
  }

  private publicSettings(): PublicSettings {
    const { password, ...rest } = this.settings;
    return { ...rest, passwordSet: password !== '' };
  }

  private handView(p: Player, hd: Hand, index: number): HandView {
    const { total, soft } = handValue(hd.cards);
    const myTurn = this.phase === 'player_turns' && this.turn === p.id && index === p.activeHand && hd.status === 'playing';
    return {
      cards: hd.cards.map((c) => ({ ...c })),
      bet: hd.bet,
      total,
      soft,
      status: hd.status,
      doubled: hd.doubled,
      allIn: hd.allIn,
      fromSplit: hd.fromSplit,
      canDouble: myTurn && canDouble(hd.cards, this.settings.doubleRule, p.chips, hd.bet, hd.fromSplit),
      outcome: hd.outcome,
      delta: hd.delta,
    };
  }

  private playerView(p: Player): PlayerView {
    const hand = p.hands[p.activeHand];
    const myTurn = this.phase === 'player_turns' && this.turn === p.id && hand !== undefined && hand.status === 'playing';
    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      ready: p.ready,
      connected: p.conn !== null,
      earnings: p.earnings,
      seat: p.seat,
      hands: p.hands.map((hd, i) => this.handView(p, hd, i)),
      activeHand: p.activeHand,
      canSplit: myTurn && canSplit(hand.cards, this.settings.splitAllowed, p.chips, hand.bet, p.hands.length > 1),
      sideBets: p.sideBets.map((sb) => ({ ...sb })),
    };
  }

  private dealerView(): DealerView {
    // The hole card is never sent until it is revealed.
    const cards: CardView[] = this.dealerCards.map((c, i) =>
      i === 1 && !this.dealerRevealed ? { hidden: true } : { ...c },
    );
    const visible = this.dealerCards.filter((_, i) => i !== 1 || this.dealerRevealed);
    const { total, soft } = handValue(visible);
    return {
      cards,
      total,
      soft,
      blackjack: this.dealerRevealed && isBlackjack(this.dealerCards),
    };
  }

  snapshot(): TableState {
    return {
      type: 'table_state',
      phase: this.phase,
      started: this.started,
      settings: this.publicSettings(),
      hostId: this.hostId,
      players: [...this.players.values()].map((p) => this.playerView(p)),
      seats: [...this.seats],
      dealer: this.dealerView(),
      turn: this.turn,
      deadline: this.deadline,
      serverNow: Date.now(),
      round: this.round,
      shuffles: this.shuffles,
      log: this.logEntries.map((e) => ({ ...e })),
    };
  }

  private broadcast(): void {
    if (this.closed) return;
    this.send(this.snapshot());
  }

  /** Sends to every connection that has joined. */
  private send(msg: ServerMsg): void {
    for (const conn of this.bound.keys()) {
      try {
        conn.send(msg);
      } catch (err) {
        this.logger(`Could not send to a client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private sendError(conn: Connection, code: ErrorCode, message: string): void {
    try {
      conn.send({ type: 'error', code, message });
    } catch (err) {
      this.logger(`Could not send an error to a client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private addLog(text: string): void {
    this.logEntries.push({ id: ++this.logId, text });
    if (this.logEntries.length > LOG_LIMIT) this.logEntries.shift();
  }

  // ----------------------------------------------------------------- timers

  private playerOf(conn: Connection): Player | undefined {
    const id = this.bound.get(conn);
    return id ? this.players.get(id) : undefined;
  }

  /** The round flow has at most one pending timer; setting a new one replaces the old. */
  private setFlow(fn: () => void, ms: number): void {
    this.clearFlow();
    if (this.closed) return;
    this.flow = setTimeout(() => {
      this.flow = null;
      try {
        fn();
      } catch (err) {
        this.logger(`Error in round flow: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }, ms);
  }

  private clearFlow(): void {
    if (this.flow) clearTimeout(this.flow);
    this.flow = null;
  }
}

function describeOutcome(outcome: Outcome, delta: number): string {
  switch (outcome) {
    case 'blackjack':
      return `wins with blackjack +${delta}`;
    case 'win':
      return `wins +${delta}`;
    case 'push':
      return 'pushes';
    case 'loss':
      return `loses ${Math.abs(delta)}`;
  }
}
