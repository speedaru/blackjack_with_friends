// The "out of chips" prompt: offers to borrow a buy-in (the starting chips) and keep playing.
// It is an in-page dialog, not a browser confirm box.

import type { PlayerView, TableState } from '../shared/types.js';
import { app, me, send } from './app.js';
import { $, fmt, fmtSigned } from './dom.js';
import { playChip } from './sound.js';
import { betOf } from './table.js';

/** The round whose prompt the player closed with "Not now", so it does not pop up again that round. */
let dismissedRound: number | null = null;
/** Set when the player opens the prompt from the Borrow button, even after dismissing it. */
let forced = false;
let busy = false;
let returnFocus: Element | null = null;

/** Out of chips and still able to place a bet this round (betting is open, seated, no bet yet). */
function isOut(s: TableState, self: PlayerView): boolean {
  return (
    s.phase === 'betting' &&
    s.deadline !== null &&
    self.seat !== null &&
    betOf(self) === 0 &&
    self.chips < s.settings.minBet
  );
}

function isOpen(): boolean {
  return !$('borrow-scrim').hidden;
}

function close(): void {
  const scrim = $('borrow-scrim');
  if (scrim.hidden) return;
  scrim.hidden = true;
  if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}

function open(s: TableState, self: PlayerView): void {
  const amount = s.settings.startingChips;
  // Borrowing counts as a loss: earnings drop to at least -amount, or stay where they are when already lower.
  const after = Math.min(self.earnings, -amount);
  $('borrow-text').textContent = `Borrow a buy-in of ${fmt(amount)} chips from the bank and keep playing?`;
  $('borrow-tab').textContent =
    after === self.earnings
      ? `Your earnings stay at ${fmtSigned(after)}. Withdraw chips later to bring them back up.`
      : `Your earnings go from ${fmtSigned(self.earnings)} to ${fmtSigned(after)}. Withdraw chips later to bring them back up.`;
  $('borrow-yes').textContent = `Borrow ${fmt(amount)}`;
  $<HTMLButtonElement>('borrow-yes').disabled = busy;
  const scrim = $('borrow-scrim');
  if (scrim.hidden) {
    returnFocus = document.activeElement;
    scrim.hidden = false;
    $('borrow-yes').focus();
  }
}

/** Shows or hides the prompt for the current table state. Call after every state update. */
export function renderBorrow(s: TableState, self: PlayerView): void {
  busy = false; // a new state answers any request we were waiting on
  const out = isOut(s, self);
  if (!out) forced = false;
  if (out && (forced || dismissedRound !== s.round)) open(s, self);
  else close();
}

/** Opens the prompt again from the Borrow button in the betting bar. */
export function openBorrowPrompt(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || !isOut(s, self)) return;
  forced = true;
  open(s, self);
}

function dismiss(): void {
  const s = app.state;
  dismissedRound = s ? s.round : null;
  forced = false;
  close();
}

function borrow(): void {
  const s = app.state;
  const self = me();
  if (busy || !s || !self || !isOut(s, self)) return;
  busy = true;
  $<HTMLButtonElement>('borrow-yes').disabled = true;
  playChip();
  send({ type: 'borrow' });
}

export function initBorrow(): void {
  $('borrow-yes').addEventListener('click', borrow);
  $('borrow-no').addEventListener('click', dismiss);
  // Clicking the dimmed area outside the dialog closes it too.
  $('borrow-scrim').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) dismiss();
  });
  document.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      dismiss();
    } else if (ev.key === 'Tab') {
      // Keep keyboard focus inside the dialog.
      const buttons = [$('borrow-yes'), $('borrow-no')].filter((b) => !(b as HTMLButtonElement).disabled);
      if (buttons.length === 0) return;
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      const next = ev.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : i === buttons.length - 1 ? 0 : i + 1;
      ev.preventDefault();
      buttons[next]!.focus();
    }
  });
}

/** True while the prompt is showing, so other keyboard shortcuts can stay out of its way. */
export function borrowPromptOpen(): boolean {
  return isOpen();
}
