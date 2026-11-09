// The felt: dealer at the top, my hand large at the bottom, other players on an arc between.

import { isHiddenCard, type HandView, type SideBetKind, type PlayerView, type PublicSettings, type TableState } from '../shared/types.js';
import { app, confirmKick, isHost, send, serverNow } from './app.js';
import {
  betChip,
  chipColor,
  handEl,
  resetCardMemory,
  resultPill,
  ringEl,
  runCardAnimations,
  setShownCards,
  slideFrom,
  tickRings,
  totalBadge,
  totalLabel,
} from './cards.js';
import { $, fmt, fmtSigned, h, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';
import { playAllIn, playChip, playDeal, playShuffle } from './sound.js';

let firstRender = true;
let lastDeadline: number | null = null;
/** The shoe reshuffle count at the last render; a rise means a reshuffle happened. */
let lastShuffles: number | null = null;
let timerTotal = 1;
/** Results and bets already shown, so their entrance animation runs only once. */
const seenResults = new Set<string>();
const seenBets = new Set<string>();
/** Set by the controls just before the player's own bet is sent, so the chip slides from there. */
let betSource: Element | null = null;

export function setBetSource(el: Element | null): void {
  betSource = el;
}

// ------------------------------------------------------------- bet circles

/** A place on the felt chips can go: the main bet or one of the side bets. */
export type Spot = 'main' | SideBetKind;

/** The bet being built in the controls, as the felt draws it. */
export interface PendingBet {
  /** True while this player can build a bet: the circles are shown. */
  open: boolean;
  /** Left to right: Perfect Pairs, main, 21+3. */
  spots: { spot: Spot; amount: number; canPlace: boolean }[];
  onPlace(spot: Spot): void;
  onClear(spot: Spot): void;
}

const SPOT_LABEL: Record<Spot, string> = { main: 'Bet', pairs: 'Perfect Pairs', plus3: '21+3' };

/** The three betting circles under my hand. Clicking one puts the picked chip there. */
function betCircles(pending: PendingBet): HTMLElement {
  const row = h('div', 'bet-circles');
  for (const { spot, amount, canPlace } of pending.spots) {
    const wrap = h('div', `bet-circle-wrap spot-${spot}`);
    const circle = h('button', 'bet-circle');
    circle.type = 'button';
    circle.dataset.spot = spot;
    circle.disabled = !canPlace;
    circle.setAttribute('aria-label', `${SPOT_LABEL[spot]}: ${amount > 0 ? fmt(amount) : 'empty'}. Place the picked chip here`);
    circle.append(h('span', 'circle-label', SPOT_LABEL[spot]));
    if (amount > 0) {
      // The amount is printed on the chip itself. Long amounts use a smaller font so they stay inside it.
      const disc = h('span', `chip-disc circle-disc ${chipColor(amount)}`);
      const text = fmt(amount);
      disc.style.setProperty('--chars', String(Math.max(text.length, 3)));
      disc.append(h('span', 'disc-amount num', text));
      circle.append(disc);
    }
    circle.addEventListener('click', () => pending.onPlace(spot));
    wrap.append(circle);
    if (amount > 0) {
      const clear = h('button', 'icon-btn circle-clear');
      clear.type = 'button';
      clear.title = `Clear ${SPOT_LABEL[spot]}`;
      clear.setAttribute('aria-label', `Clear ${SPOT_LABEL[spot]}`);
      clear.append(icon('close'));
      clear.addEventListener('click', () => pending.onClear(spot));
      wrap.append(clear);
    }
    row.append(wrap);
  }
  return row;
}

export function resetTable(): void {
  firstRender = true;
  lastDeadline = null;
  lastShuffles = null;
  seenResults.clear();
  seenBets.clear();
  handCounts.clear();
  resetCardMemory();
}

// ------------------------------------------------------------------- texts

export function rulesText(st: PublicSettings): string {
  const pays = st.blackjackPayout === '3:2' ? '3 to 2' : '6 to 5';
  const soft = st.dealerHitsSoft17 ? 'Dealer hits soft 17' : 'Dealer stands on soft 17';
  return `Blackjack pays ${pays} · ${soft}`;
}

function phaseText(s: TableState, self: PlayerView): { text: string; tone: '' | 'accent'; ring: boolean } {
  switch (s.phase) {
    case 'betting':
      if (s.deadline === null) return { text: 'Waiting for players', tone: '', ring: false };
      if (self.seat !== null && betOf(self) === 0 && self.chips >= s.settings.minBet) {
        return { text: 'Place your bet', tone: 'accent', ring: false }; // the bet panel has the ring
      }
      return { text: 'Waiting for bets', tone: '', ring: true };
    case 'dealing':
      return { text: 'Dealing', tone: '', ring: false };
    case 'player_turns': {
      const p = s.players.find((x) => x.id === s.turn);
      if (!p) return { text: '', tone: '', ring: false };
      return p.id === self.id ? { text: 'Your turn', tone: 'accent', ring: false } : { text: `${p.name}'s turn`, tone: '', ring: false };
    }
    case 'dealer_turn':
      return { text: s.dealer.blackjack ? 'Dealer has blackjack' : "Dealer's turn", tone: '', ring: false };
    case 'settle':
      return { text: 'Round over', tone: '', ring: false };
    default:
      return { text: '', tone: '', ring: false };
  }
}

// ------------------------------------------------------------------- hands

/** A hand slot with nothing in it yet (before the deal, or when sitting out). */
const NO_HAND: HandView = {
  cards: [],
  bet: 0,
  total: 0,
  soft: false,
  status: 'none',
  doubled: false,
  allIn: false,
  fromSplit: false,
  canDouble: false,
  outcome: null,
  delta: null,
};

export function betOf(p: PlayerView): number {
  return p.hands[0]?.bet ?? 0;
}

function handTotal(s: TableState, hd: HandView): HTMLElement | null {
  if (hd.cards.length === 0) return null;
  if (hd.status === 'bust') return totalBadge(String(hd.total), 'bust');
  if (hd.status === 'blackjack') return totalBadge('21', 'bj');
  const final = hd.status !== 'playing' || s.phase === 'settle';
  return totalBadge(totalLabel(hd.total, hd.soft, final));
}

/** Hand counts at the last render, to spot the moment a hand is split. */
const handCounts = new Map<string, number>();

/** The animation key of a player's hand: the first hand keeps the plain player id. */
function handKey(p: PlayerView, i: number): string {
  return i === 0 ? p.id : `${p.id}:${i}`;
}

/** When a hand has just been split, its first card was already on screen: only the new cards slide in. */
function noteSplit(p: PlayerView): void {
  const before = handCounts.get(p.id) ?? 0;
  handCounts.set(p.id, p.hands.length);
  if (before === 1 && p.hands.length === 2) {
    setShownCards(handKey(p, 0), 1);
    setShownCards(handKey(p, 1), 1);
  }
}

/** Cards plus the total badge (top right) and, on that hand's turn, the countdown ring (top left). */
function handBox(
  s: TableState,
  key: string,
  hd: HandView,
  size: 'lg' | 'sm',
  counts: { added: number },
  opts: { ring: boolean; active: boolean },
): HTMLElement {
  const box = h('div', `hand-box size-${size}`);
  if (opts.active) box.classList.add('active-hand');
  const { el, added } = handEl(key, hd.cards, !firstRender);
  counts.added += added;
  box.append(el);
  const badge = handTotal(s, hd);
  if (badge) box.append(badge);
  if (size === 'lg' && opts.ring && s.deadline !== null) box.append(ringEl('hand-ring'));
  return box;
}

/** The spot under a hand: the result once settled, else the bet chip. */
function betSpot(s: TableState, p: PlayerView, index: number): HTMLElement {
  const hd = p.hands[index] ?? NO_HAND;
  const spot = h('div', 'bet-spot');
  const result = resultPill(hd);
  if (result) {
    spot.append(result);
    const key = `${s.round}:${p.id}:${index}`;
    if (!seenResults.has(key)) {
      seenResults.add(key);
      if (!firstRender) result.classList.add('enter');
    }
    return spot;
  }
  if (hd.bet > 0) {
    const chip = betChip(hd.bet, { doubled: hd.doubled, allIn: hd.allIn });
    spot.append(chip);
    const key = `${s.round}:${p.id}:${index}:${hd.bet}`;
    if (!seenBets.has(key)) {
      seenBets.add(key);
      if (!firstRender) {
        if (p.id === app.myId && index === 0 && betSource) {
          const from = betSource;
          requestAnimationFrame(() => slideFrom(chip, from));
          betSource = null;
        } else {
          chip.classList.add('enter');
        }
      }
    }
    return spot;
  }
  return spot;
}

const SIDE_TAG: Record<SideBetKind, string> = { pairs: 'PAIRS', plus3: '21+3' };

/** Small tags for the player's side bets: the stake while waiting, then the win or the loss. */
function sideTags(s: TableState, p: PlayerView): HTMLElement | null {
  if (p.sideBets.length === 0) return null;
  const box = h('div', 'side-tags');
  for (const sb of p.sideBets) {
    const tag = h('span', 'side-tag num');
    if (sb.delta === null) {
      tag.textContent = `${SIDE_TAG[sb.kind]} ${fmt(sb.bet)}`;
      tag.title = `Side bet of ${fmt(sb.bet)}`;
    } else {
      tag.classList.add(sb.delta > 0 ? 'win' : 'lost');
      tag.textContent = `${SIDE_TAG[sb.kind]} ${fmtSigned(sb.delta)}`;
      tag.title = sb.result ? `${sb.result}: ${fmtSigned(sb.delta)}` : `Lost ${fmt(sb.bet)}`;
      const key = `side:${s.round}:${p.id}:${sb.kind}`;
      if (!seenResults.has(key)) {
        seenResults.add(key);
        if (!firstRender) tag.classList.add('enter');
      }
    }
    box.append(tag);
  }
  return box;
}

// ------------------------------------------------------------------ dealer

function renderDealer(s: TableState, counts: { added: number }): void {
  const box = $('dealer');
  const hand = h('div', 'hand-box size-dealer');
  const { el, added } = handEl('dealer', s.dealer.cards, !firstRender);
  counts.added += added;
  hand.append(el);
  if (s.dealer.cards.length === 0) hand.classList.add('empty');
  const visible = s.dealer.cards.filter((c) => !isHiddenCard(c)).length;
  if (visible > 0) {
    if (s.dealer.blackjack) hand.append(totalBadge('21', 'bj'));
    else if (s.dealer.total > 21) hand.append(totalBadge(String(s.dealer.total), 'bust'));
    else hand.append(totalBadge(totalLabel(s.dealer.total, s.dealer.soft, s.phase === 'settle')));
  }
  box.classList.toggle('is-turn', s.phase === 'dealer_turn');
  box.replaceChildren(h('span', 'spot-label', 'Dealer'), hand);
}

// ------------------------------------------------------------------- seats

/**
 * The other seated players in seat order, starting with the one after me. Going round the table:
 * me, then my left side from near to far, over the dealer, then my right side from far to near.
 */
function othersInOrder(s: TableState, self: PlayerView): PlayerView[] {
  const n = s.seats.length;
  const start = self.seat === null ? 0 : self.seat + 1;
  const out: PlayerView[] = [];
  for (let k = 0; k < n; k++) {
    const id = s.seats[(start + k) % n];
    const p = id && id !== self.id ? s.players.find((x) => x.id === id) : undefined;
    if (p) out.push(p);
  }
  return out;
}

/**
 * Positions (in % of the felt) on an elliptical arc around my hand. Seats are spaced evenly
 * across the width rather than by angle, so boxes near the sides do not pile up.
 */
function arcPositions(count: number): { x: number; y: number }[] {
  const leftCount = Math.ceil(count / 2);
  const rightCount = count - leftCount;
  const onArc = (dx: number) => {
    const rx = 46;
    const t = Math.min(1, Math.abs(dx) / rx);
    return { x: 50 + dx, y: 28 + 36 * Math.sqrt(1 - t * t) };
  };
  /** Offsets from the centre, near my hand first. */
  const side = (k: number): number[] => {
    if (k === 0) return [];
    if (k === 1) return [29];
    return Array.from({ length: k }, (_, i) => 21 + (21 * i) / (k - 1));
  };
  const left = side(leftCount).map((d) => onArc(-d));
  const right = side(rightCount).map((d) => onArc(d)).reverse();
  return [...left, ...right];
}

function seatEl(s: TableState, p: PlayerView, counts: { added: number }): HTMLElement {
  const seat = h('div', 'seat');
  if (s.turn === p.id) seat.classList.add('is-turn');
  if (!p.connected) seat.classList.add('away');
  const outcomes = p.hands.map((hd) => hd.outcome).filter((o) => o !== null);
  if (outcomes.length > 0) seat.classList.add(`outcome-${outcomes.every((o) => o === 'loss') ? 'loss' : 'other'}`);

  const head = h('div', 'seat-head');
  if (s.turn === p.id && s.deadline !== null) head.append(ringEl('seat-ring'));
  head.append(h('span', 'seat-name', p.name));
  if (p.id === s.hostId) head.title = `${p.name} is the host`;
  if (!p.connected) head.append(h('span', 'tag', 'Away'));
  seat.append(head);

  noteSplit(p);
  const split = p.hands.length > 1;
  const turnHere = s.turn === p.id;
  const ids = split ? p.hands.map((_, i) => i) : [0];
  const boxes = ids.map((i) =>
    handBox(s, handKey(p, i), p.hands[i] ?? NO_HAND, 'sm', counts, { ring: false, active: split && turnHere && p.activeHand === i }),
  );
  if (split) {
    const row = h('div', 'hands-row');
    row.append(...boxes);
    seat.append(row);
    seat.classList.add('is-split');
  } else {
    seat.append(boxes[0]!);
  }

  const foot = h('div', 'seat-foot');
  foot.append(...ids.map((i) => betSpot(s, p, i)), h('span', 'seat-chips num', fmt(p.chips)));
  seat.append(foot);
  const sides = sideTags(s, p);
  if (sides) seat.append(sides);

  if (isHost()) {
    const kick = h('button', 'icon-btn seat-kick');
    kick.type = 'button';
    kick.title = `Kick ${p.name}`;
    kick.setAttribute('aria-label', `Kick ${p.name}`);
    kick.append(icon('close'));
    kick.addEventListener('click', () => confirmKick(p));
    seat.append(kick);
  }
  return seat;
}

function renderOthers(s: TableState, self: PlayerView, counts: { added: number }): void {
  const box = $('others');
  // Only occupied seats are drawn. Players who are watching (no seat yet) are not on the felt.
  const others = othersInOrder(s, self);
  const positions = arcPositions(others.length);
  const nodes = others.map((p, i) => {
    const el = seatEl(s, p, counts);
    el.style.setProperty('--x', `${positions[i]!.x}%`);
    el.style.setProperty('--y', `${positions[i]!.y}%`);
    return el;
  });
  box.replaceChildren(...nodes);
  box.classList.toggle('has-turn', nodes.some((n) => n.classList.contains('is-turn')));
}

// ------------------------------------------------------------------ my spot

function renderMe(s: TableState, self: PlayerView, pending: PendingBet, counts: { added: number }): void {
  const spot = $('my-spot');
  // With two hands only the hand being played is lit (see .active-hand), not the whole spot.
  spot.classList.toggle('is-turn', s.turn === self.id && self.hands.length < 2);
  if (self.seat === null) {
    spot.replaceChildren(h('p', 'spot-note', "You're watching. You'll take a free seat when the next round starts."));
    return;
  }
  noteSplit(self);
  const nodes: HTMLElement[] = [];
  const split = self.hands.length > 1;
  const myTurn = s.turn === self.id;
  if (split) {
    // Both hands side by side, each with its own total, bet and result. The one being played is lit.
    const row = h('div', myTurn ? 'hands-row has-active' : 'hands-row');
    self.hands.forEach((hd, i) => {
      const active = myTurn && self.activeHand === i;
      const col = h('div', active ? 'hand-col active' : 'hand-col');
      col.append(
        handBox(s, handKey(self, i), hd, 'lg', counts, { ring: active, active }),
        betSpot(s, self, i),
      );
      row.append(col);
    });
    nodes.push(row);
  } else if (pending.open) {
    // While I build a bet there are no cards yet, so the three circles take the hand's place.
    nodes.push(betCircles(pending));
  } else {
    nodes.push(handBox(s, self.id, self.hands[0] ?? NO_HAND, 'lg', counts, { ring: myTurn, active: false }));
    nodes.push(betSpot(s, self, 0));
  }
  const sides = sideTags(s, self);
  if (sides) nodes.push(sides);
  const name = h('div', 'my-name');
  name.append(h('span', 'name', self.name));
  nodes.push(name);
  spot.replaceChildren(...nodes);
  spot.classList.toggle('is-split', split);
  spot.classList.toggle('no-cards', (self.hands[0]?.cards.length ?? 0) === 0);
}

// -------------------------------------------------------------------- main

/** Draws the felt for this state. `pending` is the bet being built in the controls. */
export function renderTable(s: TableState, self: PlayerView, pending: PendingBet): void {
  const counts = { added: 0 };

  // The round number goes up when the cards are dealt, so betting is for the next round.
  $('round-label').textContent = `Round ${s.round + (s.phase === 'betting' ? 1 : 0)}`;
  if (s.deadline !== lastDeadline) {
    lastDeadline = s.deadline;
    timerTotal = s.deadline ? Math.max(1, s.deadline - s.serverNow) : 1;
  }

  renderDealer(s, counts);

  const pill = $('phase-pill');
  const phase = phaseText(s, self);
  pill.replaceChildren();
  if (phase.ring && s.deadline !== null) pill.append(ringEl('pill-ring'));
  pill.append(h('span', undefined, phase.text));
  pill.className = `phase-pill ${phase.tone}`.trim();
  pill.hidden = phase.text === '';

  $('felt-rules').textContent = rulesText(s.settings);
  renderOthers(s, self, counts);
  renderMe(s, self, pending, counts);

  runCardAnimations();
  if (!firstRender && counts.added > 0) playDeal();
  const prev = app.prevState;
  if (prev && s.phase === 'betting') {
    const before = new Map(prev.players.map((p) => [p.id, betOf(p)]));
    const newBets = s.players.filter((p) => betOf(p) > 0 && (before.get(p.id) ?? 0) === 0 && p.id !== app.myId);
    if (newBets.some((p) => p.hands[0]?.allIn)) playAllIn();
    else if (newBets.length > 0) playChip();
  }
  if (lastShuffles !== null && s.shuffles > lastShuffles) playShuffle();
  lastShuffles = s.shuffles;
  firstRender = false;
  tick();
}

/** Only the pending chip under my hand changes while I build a bet; no need to redraw everything. */
export function updatePendingBet(s: TableState, self: PlayerView, pending: PendingBet): void {
  renderMe(s, self, pending, { added: 0 });
  tick();
}

// -------------------------------------------------------------------- timer

function tick(): void {
  const s = app.state;
  if (!s || s.phase === 'waiting' || s.deadline === null) return;
  tickRings(Math.max(0, s.deadline - serverNow()), timerTotal);
}

setInterval(tick, prefersReducedMotion() ? 500 : 100);
