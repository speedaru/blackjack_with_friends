// Betting panel and action buttons under the felt, plus their keyboard shortcuts.

import { SIDE_BET_KINDS, SIDE_BET_NAMES, type ActionName, type SideBetChoice, type SideBetKind } from '../shared/types.js';
import { app, me, send } from './app.js';
import { openBorrowPrompt } from './borrow.js';
import { slideFrom, ringEl } from './cards.js';
import { $, fmt, h } from './dom.js';
import { playAllIn, playChip } from './sound.js';
import { betOf, setBetSource, updatePendingBet } from './table.js';

const CHIP_VALUES = [10, 25, 100, 500];

let pendingBet = 0;
/** The last bet this player confirmed. Each new round starts with it already in the bet box. */
let lastBet = 0;
/** The round whose bet box was already filled with the last bet, so Clear is not undone by the next update. */
let prefilledRound = -1;
let actionBusy = false;

export function getPendingBet(): number {
  return pendingBet;
}

/** A new state arrived, so any request we were waiting on has been answered. */
export function clearBusy(): void {
  actionBusy = false;
}

// ---------------------------------------------------------------- bet spots

/** Where the chip buttons, Clear, ½ and ×2 put their chips: the main bet or one of the side bets. */
type Spot = 'main' | SideBetKind;

let selected: Spot = 'main';
/** Side bet amounts being built. 0 means no side bet. */
const pendingSide: Record<SideBetKind, number> = { pairs: 0, plus3: 0 };
/** The side bets confirmed with the last bet. They come back with it the next round. */
let lastSide: Record<SideBetKind, number> = { pairs: 0, plus3: 0 };

function sideTotal(): number {
  return SIDE_BET_KINDS.reduce((sum, k) => sum + pendingSide[k], 0);
}

function clearSides(): void {
  for (const k of SIDE_BET_KINDS) pendingSide[k] = 0;
}

function sideBetsMsg(): SideBetChoice {
  const out: SideBetChoice = {};
  for (const k of SIDE_BET_KINDS) if (pendingSide[k] > 0) out[k] = pendingSide[k];
  return out;
}

function amountOf(spot: Spot): number {
  return spot === 'main' ? pendingBet : pendingSide[spot];
}

/**
 * Most chips a spot may hold right now. The main bet gets the chips the side bets leave; a side bet
 * gets what the rest leaves, and never more than the main bet.
 */
function capFor(spot: Spot): number {
  const self = me();
  if (!self) return 0;
  const free = self.chips - pendingBet - sideTotal() + amountOf(spot);
  return Math.max(0, spot === 'main' ? free : Math.min(free, pendingBet));
}

/** Why the bet can not be confirmed as it stands, or null when it can (or there is nothing to say). */
function sideProblem(minBet: number): string | null {
  for (const k of SIDE_BET_KINDS) {
    const v = pendingSide[k];
    if (v === 0) continue;
    if (v < minBet) return `${SIDE_BET_NAMES[k]} needs at least ${fmt(minBet)}`;
    if (v > pendingBet) return 'Side bets can be at most your bet';
  }
  return null;
}

function selectSpot(spot: Spot): void {
  selected = spot;
  renderControls();
}

/** Sets the amount on the selected spot. */
function setSelected(value: number, from?: Element): void {
  if (selected === 'main') return setPending(value, from);
  pendingSide[selected] = Math.max(0, Math.min(value, capFor(selected)));
  renderControls();
}

function setPending(value: number, from?: Element): void {
  pendingBet = Math.max(0, Math.min(value, capFor('main')));
  renderControls();
  const s = app.state;
  const self = me();
  if (s && self && s.phase !== 'waiting') {
    updatePendingBet(s, self, pendingBet);
    const disc = document.querySelector('#my-spot .bet-chip.pending .chip-disc');
    if (from && disc) slideFrom(disc as HTMLElement, from);
  }
}

function confirmBet(): void {
  const btn = $<HTMLButtonElement>('confirm-bet');
  if (btn.disabled || actionBusy) return;
  actionBusy = true;
  lastBet = pendingBet;
  lastSide = { ...pendingSide };
  playChip();
  setBetSource($('pending-bet'));
  send({ type: 'place_bet', amount: pendingBet, sideBets: sideBetsMsg() });
  renderControls();
}

// ------------------------------------------------------------------ all in

/** How long the "Confirm all in?" question waits for a second click. */
const ALL_IN_CONFIRM_MS = 3000;

let allInArmed = false;
let allInTimer: number | null = null;

function disarmAllIn(): void {
  if (allInTimer !== null) window.clearTimeout(allInTimer);
  allInTimer = null;
  if (!allInArmed) return;
  allInArmed = false;
  renderControls();
}

function onAllInClick(): void {
  const btn = $<HTMLButtonElement>('allin-btn');
  const self = me();
  if (btn.disabled || actionBusy || !self) return;
  if (!allInArmed) {
    allInArmed = true;
    allInTimer = window.setTimeout(disarmAllIn, ALL_IN_CONFIRM_MS);
    renderControls();
    return;
  }
  // Second click: the whole stack becomes the bet and is confirmed.
  if (allInTimer !== null) window.clearTimeout(allInTimer);
  allInTimer = null;
  allInArmed = false;
  actionBusy = true;
  // The whole stack goes in: the side bets as they are, and everything else on the main bet. Side bets
  // that would then be above the main bet (or leave it under the minimum) are dropped.
  const minBet = app.state?.settings.minBet ?? 0;
  let amount = self.chips - sideTotal();
  if (amount < minBet || SIDE_BET_KINDS.some((k) => pendingSide[k] > amount)) {
    clearSides();
    amount = self.chips;
  }
  pendingBet = amount;
  lastBet = amount;
  lastSide = { ...pendingSide };
  playAllIn();
  setBetSource($('pending-bet'));
  send({ type: 'place_bet', amount, sideBets: sideBetsMsg() });
  renderControls();
}

const ACTION_BUTTONS: Record<ActionName, string> = {
  hit: 'hit-btn',
  stand: 'stand-btn',
  double: 'double-btn',
  split: 'split-btn',
};

function act(action: ActionName): void {
  const btn = $<HTMLButtonElement>(ACTION_BUTTONS[action]);
  if (btn.disabled || actionBusy) return;
  actionBusy = true;
  send({ type: 'action', action });
  renderControls();
}

/** Brief pressed look when a shortcut key is used, so the player sees which button fired. */
function flash(id: string): void {
  const el = $(id);
  el.classList.remove('key-pressed');
  void el.offsetWidth;
  el.classList.add('key-pressed');
  window.setTimeout(() => el.classList.remove('key-pressed'), 160);
}

function onKey(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement | null;
  // Pressing any other key cancels a pending all in. Enter/Space on the button itself is its own click.
  if (allInArmed && !target?.closest('#allin-btn')) disarmAllIn();
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
  if ($('screen-table').hidden) return;
  if (document.querySelector('.modal-scrim:not([hidden])')) return; // a dialog is open: its keys are its own
  if (target && (target.closest('input, textarea, select, [contenteditable="true"]') !== null)) return;
  // Leave Enter and Space alone on buttons outside the controls (log, rules, leave...).
  const onOtherButton = target?.closest('button') && !target.closest('.table-controls');

  const key = ev.key.toLowerCase();
  if (key === 'enter') {
    if (onOtherButton || $('bet-bar').hidden || $<HTMLButtonElement>('confirm-bet').disabled) return;
    ev.preventDefault(); // otherwise Enter on a focused chip would add another chip
    flash('confirm-bet');
    confirmBet();
    return;
  }
  const KEYS: Record<string, ActionName> = { h: 'hit', s: 'stand', d: 'double', p: 'split' };
  const action: ActionName | null = KEYS[key] ?? null;
  if (!action || $('action-bar').hidden) return;
  const id = ACTION_BUTTONS[action];
  if ($<HTMLButtonElement>(id).disabled) return;
  ev.preventDefault();
  flash(id);
  act(action);
}

export function initControls(): void {
  const box = $('chip-buttons');
  for (const v of CHIP_VALUES) {
    const b = h('button', `chip-btn c${v}`);
    b.type = 'button';
    b.dataset.value = String(v);
    b.setAttribute('aria-label', `Add ${v} to the selected bet`);
    b.append(h('span', 'chip-face num', String(v)));
    b.addEventListener('click', () => {
      playChip();
      setSelected(amountOf(selected) + v, b);
    });
    box.append(b);
  }
  $('bet-ring-slot').append(ringEl('bet-ring'));
  $('clear-bet').addEventListener('click', () => setSelected(0));
  $('half-bet').addEventListener('click', (ev) => setSelected(Math.floor(amountOf(selected) / 2), ev.currentTarget as Element));
  $('double-bet').addEventListener('click', (ev) => setSelected(amountOf(selected) * 2, ev.currentTarget as Element));
  $('confirm-bet').addEventListener('click', confirmBet);
  $('spot-main').addEventListener('click', () => selectSpot('main'));
  for (const kind of SIDE_BET_KINDS) {
    $(`side-${kind}`).addEventListener('click', () => selectSpot(kind));
  }
  $('allin-btn').addEventListener('click', onAllInClick);
  // Clicking anything else cancels the all-in question (capture, so it runs before that click's own handler).
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (allInArmed && !(ev.target as HTMLElement | null)?.closest('#allin-btn')) disarmAllIn();
    },
    true,
  );
  $('borrow-btn').addEventListener('click', openBorrowPrompt);
  for (const action of Object.keys(ACTION_BUTTONS) as ActionName[]) {
    $(ACTION_BUTTONS[action]).addEventListener('click', () => act(action));
  }
  document.addEventListener('keydown', onKey);
}

/** Shows the bet panel or the action buttons and enables what the player can do right now. */
export function renderControls(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || s.phase === 'waiting') return;

  const seated = self.seat !== null;
  const myBet = betOf(self);
  const outOfChips = self.chips < s.settings.minBet && myBet === 0;
  const canBet = s.phase === 'betting' && seated && myBet === 0 && !outOfChips && s.deadline !== null;
  const { minBet } = s.settings;
  if (!canBet) {
    pendingBet = 0;
    clearSides();
    selected = 'main';
  }
  // A new betting round starts with the last bet (and its side bets) already in place, ready to confirm.
  if (canBet && prefilledRound !== s.round) {
    prefilledRound = s.round;
    selected = 'main';
    if (pendingBet === 0) {
      const again = Math.min(lastBet, self.chips);
      if (again >= minBet) {
        pendingBet = again;
        // The side bets come back only when the chips cover them and they still fit under the bet.
        const sides = SIDE_BET_KINDS.reduce((sum, k) => sum + lastSide[k], 0);
        const fit = again + sides <= self.chips && SIDE_BET_KINDS.every((k) => lastSide[k] <= again);
        for (const k of SIDE_BET_KINDS) pendingSide[k] = fit ? lastSide[k] : 0;
      }
    }
  }
  const busy = actionBusy;
  const cap = capFor(selected);
  const here = amountOf(selected);

  // ---- all in: the button is enabled with at least the minimum bet; armed shows the confirm question
  const allInBtn = $<HTMLButtonElement>('allin-btn');
  const allInOk = canBet && !busy && self.chips >= s.settings.minBet;
  if (!allInOk && allInArmed) {
    allInArmed = false;
    if (allInTimer !== null) window.clearTimeout(allInTimer);
    allInTimer = null;
  }
  allInBtn.disabled = !allInOk;
  allInBtn.classList.toggle('armed', allInArmed);
  $('allin-label').textContent = allInArmed ? `Confirm all in (${fmt(self.chips)})?` : 'All in';
  allInBtn.title = allInArmed ? 'Click again to bet everything' : 'Bet all your chips';

  // ---- betting
  const betBar = $('bet-bar');
  betBar.hidden = !(s.phase === 'betting' && seated && myBet === 0 && s.deadline !== null);
  betBar.classList.toggle('out-of-chips', outOfChips);
  $('pending-bet').textContent = fmt(pendingBet);
  const sides = sideTotal();
  $('bet-limits').textContent = sides > 0 ? `Min ${fmt(minBet)} · total ${fmt(pendingBet + sides)}` : `Min ${fmt(minBet)}`;

  // The spots: which one the chips go to, and how much each holds.
  const spots: [Spot, string][] = [['main', 'spot-main'], ...SIDE_BET_KINDS.map((k): [Spot, string] => [k, `side-${k}`])];
  for (const [spot, id] of spots) {
    const b = $<HTMLButtonElement>(id);
    b.setAttribute('aria-pressed', String(selected === spot));
    b.classList.toggle('has-amount', amountOf(spot) > 0);
    b.disabled = !canBet || busy;
    const amt = b.querySelector('.spot-amount');
    if (amt) amt.textContent = amountOf(spot) > 0 ? fmt(amountOf(spot)) : '–';
  }
  const problem = canBet ? sideProblem(minBet) : null;
  let hint = problem ?? '';
  if (!hint && canBet && selected !== 'main' && pendingBet === 0) hint = 'Place your main bet first';
  $('bet-hint').textContent = hint;
  $('bet-hint').classList.toggle('warn', problem !== null);

  // Chips go to the selected spot. A side bet can't go above the main bet, so chips that would do that are off.
  for (const b of document.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
    const v = Number(b.dataset.value);
    const over = selected === 'main' ? here >= cap : here + v > cap;
    b.disabled = !canBet || busy || over;
  }
  $<HTMLButtonElement>('clear-bet').disabled = !canBet || busy || here === 0;
  $<HTMLButtonElement>('half-bet').disabled = !canBet || busy || here < 2;
  $<HTMLButtonElement>('double-bet').disabled = !canBet || busy || here === 0 || here >= cap;
  $<HTMLButtonElement>('confirm-bet').disabled = !canBet || busy || pendingBet < minBet || problem !== null;
  const borrow = $<HTMLButtonElement>('borrow-btn');
  borrow.hidden = !outOfChips || s.deadline === null;
  borrow.disabled = busy;

  // ---- actions: shown for the whole round so the layout does not jump between phases
  const inRound = seated && (self.hands[0]?.cards.length ?? 0) > 0;
  $('action-bar').hidden = !(inRound && s.phase !== 'betting');
  const myTurn = s.phase === 'player_turns' && s.turn === self.id && !busy;
  $<HTMLButtonElement>('hit-btn').disabled = !myTurn;
  $<HTMLButtonElement>('stand-btn').disabled = !myTurn;
  $<HTMLButtonElement>('double-btn').disabled = !(myTurn && self.hands[self.activeHand]?.canDouble);
  // Split is always shown; it is only enabled when splitting is allowed right now.
  $<HTMLButtonElement>('split-btn').disabled = !(myTurn && self.canSplit);
  $('action-bar').classList.toggle('my-turn', s.phase === 'player_turns' && s.turn === self.id);

  // ---- note
  const note = $('watch-note');
  let text = '';
  if (seated && s.phase === 'betting' && outOfChips) text = "You're out of chips. Borrow a buy-in to keep playing.";
  else if (seated && s.phase === 'betting' && myBet > 0) text = 'Bet placed. Waiting for the others.';
  else if (seated && self.hands.length === 0 && s.phase !== 'betting') text = "You're sitting out this round.";
  note.textContent = text;
  note.hidden = text === '';
}

