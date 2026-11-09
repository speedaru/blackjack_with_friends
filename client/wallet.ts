// The wallet: balance, earnings and the Withdraw button, shown top left on the table and in the waiting
// room, plus the dialog that asks how much to withdraw.
//
// Earnings is the one number that says where you stand. Losing and borrowing push it down; winning and
// withdrawing push it up. When it is negative you are in debt, and Withdraw moves chips from your balance
// onto it (earnings −2,000, withdraw 1,000, earnings −1,000).

import type { PlayerView, TableState } from '../shared/types.js';
import { app, me, send } from './app.js';
import { $, fmt, fmtSigned, h } from './dom.js';
import { playChip } from './sound.js';
import { betOf } from './table.js';

let returnFocus: Element | null = null;

/** The most the player can withdraw right now: their chips, up to what they owe. */
function maxWithdraw(self: PlayerView): number {
  return Math.max(0, Math.min(self.chips, -self.earnings));
}

/** Why Withdraw is unavailable right now, or null when it works. Only called while in debt. */
function blockedReason(s: TableState, self: PlayerView): string | null {
  const phaseOk = s.phase === 'waiting' || (s.phase === 'betting' && betOf(self) === 0);
  if (!phaseOk) return 'You can withdraw in the waiting room or before you bet';
  if (self.chips <= 0) return 'You have no chips to withdraw';
  return null;
}

// ------------------------------------------------------------------ the panel

function statEl(label: string, key: string): HTMLElement {
  const stat = h('div', 'wallet-stat');
  const value = h('span', 'wallet-value num');
  value.dataset.wallet = key;
  stat.append(h('span', 'wallet-label', label), value);
  return stat;
}

/** Fills every `[data-wallet-panel]` element (one per screen) with the same three parts. */
function buildPanels(): void {
  for (const panel of document.querySelectorAll<HTMLElement>('[data-wallet-panel]')) {
    panel.classList.add('wallet');
    const btn = h('button', 'ghost wallet-withdraw', 'Withdraw');
    btn.type = 'button';
    btn.dataset.wallet = 'withdraw';
    btn.addEventListener('click', openWithdraw);
    panel.append(statEl('Balance', 'balance'), statEl('Earnings', 'earnings'), btn);
  }
}

export function renderWallet(s: TableState, self: PlayerView): void {
  const inDebt = self.earnings < 0;
  const reason = inDebt ? blockedReason(s, self) : null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-wallet]')) {
    switch (el.dataset.wallet) {
      case 'balance':
        el.textContent = fmt(self.chips);
        break;
      case 'earnings':
        el.textContent = fmtSigned(self.earnings);
        el.classList.toggle('is-up', self.earnings > 0);
        el.classList.toggle('is-down', self.earnings < 0);
        el.title = inDebt
          ? 'You are in debt. Wins and withdrawals bring this back up.'
          : 'What you have won or lost. Borrowing counts as a loss.';
        break;
      case 'withdraw': {
        const btn = el as HTMLButtonElement;
        btn.hidden = !inDebt;
        btn.disabled = reason !== null;
        btn.title = reason ?? 'Take chips out of your balance to pay down what you owe';
        break;
      }
    }
  }
  // The dialog follows the state: it closes when withdrawing stops being possible, and keeps the max current.
  if (isOpen()) {
    if (!inDebt || reason !== null) close();
    else updatePreview(self);
  }
}

// ----------------------------------------------------------------- the dialog

const input = (): HTMLInputElement => $<HTMLInputElement>('withdraw-amount');

function isOpen(): boolean {
  return !$('withdraw-scrim').hidden;
}

function close(): void {
  const scrim = $('withdraw-scrim');
  if (scrim.hidden) return;
  scrim.hidden = true;
  if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}

/** The typed amount as a whole number, or 0 when it is empty or not a number. */
function typedAmount(): number {
  const n = Number(input().value.replace(/[,\s]/g, ''));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function setAmount(n: number): void {
  input().value = n > 0 ? String(n) : '';
  const self = me();
  if (self) updatePreview(self);
}

function updatePreview(self: PlayerView): void {
  const max = maxWithdraw(self);
  const amount = typedAmount();
  const valid = amount >= 1 && amount <= max;
  $('withdraw-max-note').textContent = `You can withdraw up to ${fmt(max)}`;
  $('withdraw-preview').textContent = valid
    ? `Earnings ${fmtSigned(self.earnings)} → ${fmtSigned(self.earnings + amount)} · Balance ${fmt(self.chips)} → ${fmt(self.chips - amount)}`
    : amount > max
      ? `That is more than the ${fmt(max)} you can withdraw`
      : `Earnings ${fmtSigned(self.earnings)}`;
  $<HTMLButtonElement>('withdraw-yes').disabled = !valid;
  $<HTMLButtonElement>('withdraw-half').disabled = max < 1;
  $<HTMLButtonElement>('withdraw-max').disabled = max < 1;
}

function openWithdraw(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || self.earnings >= 0 || blockedReason(s, self) !== null) return;
  if (!isOpen()) {
    returnFocus = document.activeElement;
    $('withdraw-scrim').hidden = false;
  }
  setAmount(0);
  input().focus();
}

function submit(ev: Event): void {
  ev.preventDefault();
  const s = app.state;
  const self = me();
  if (!s || !self) return;
  const amount = typedAmount();
  if (amount < 1 || amount > maxWithdraw(self)) return;
  playChip();
  send({ type: 'withdraw', amount });
  close(); // the next state shows the new numbers; a refusal comes back as a toast
}

export function initWallet(): void {
  buildPanels();
  $('withdraw-form').addEventListener('submit', submit);
  $('withdraw-no').addEventListener('click', close);
  $('withdraw-max').addEventListener('click', () => {
    const self = me();
    if (self) setAmount(maxWithdraw(self));
  });
  $('withdraw-half').addEventListener('click', () => {
    const self = me();
    if (self) setAmount(Math.max(1, Math.floor(maxWithdraw(self) / 2)));
  });
  input().addEventListener('input', () => {
    // Keep digits only, so the amount is always a whole number.
    const digits = input().value.replace(/\D/g, '');
    if (digits !== input().value) input().value = digits;
    const self = me();
    if (self) updatePreview(self);
  });
  // Clicking the dimmed area outside the dialog closes it too.
  $('withdraw-scrim').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'Tab') {
      // Keep keyboard focus inside the dialog.
      const items = [input(), $('withdraw-half'), $('withdraw-max'), $('withdraw-no'), $('withdraw-yes')].filter(
        (b) => !(b as HTMLButtonElement | HTMLInputElement).disabled,
      );
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      ev.preventDefault();
      items[next]!.focus();
    }
  });
}
