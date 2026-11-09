// Waiting room: the player list and the host's table settings.

import { SETTINGS_LIMITS, type PlayerView, type PublicSettings, type Settings, type TableState } from '../shared/types.js';
import { app, confirmKick, isHost, me, resetChips, send, toast } from './app.js';
import { $, fmt, fmtSigned, h } from './dom.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------- settings

type Field =
  | { kind: 'int'; key: keyof Settings; label: string; min?: number; max?: number; unit?: string }
  | { kind: 'segment'; key: keyof Settings; label: string; options: [string, string][] }
  | { kind: 'password'; key: 'password'; label: string }
  | { kind: 'turn'; key: 'turnSeconds'; label: string };

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Table',
    fields: [
      { kind: 'int', key: 'maxPlayers', label: 'Max players', ...SETTINGS_LIMITS.maxPlayers },
      { kind: 'int', key: 'startingChips', label: 'Starting chips', ...SETTINGS_LIMITS.startingChips },
      { kind: 'password', key: 'password', label: 'Password' },
    ],
  },
  {
    title: 'Bets',
    fields: [
      { kind: 'int', key: 'minBet', label: 'Minimum bet', min: 1 },
    ],
  },
  {
    title: 'Timers',
    fields: [
      { kind: 'int', key: 'bettingSeconds', label: 'Betting time', unit: 's', ...SETTINGS_LIMITS.bettingSeconds },
      { kind: 'turn', key: 'turnSeconds', label: 'Turn time' },
    ],
  },
  {
    title: 'Rules',
    fields: [
      { kind: 'int', key: 'decks', label: 'Decks in the shoe', ...SETTINGS_LIMITS.decks },
      {
        kind: 'segment',
        key: 'dealerHitsSoft17',
        label: 'Dealer on soft 17',
        options: [
          ['false', 'Stands'],
          ['true', 'Hits'],
        ],
      },
      {
        kind: 'segment',
        key: 'blackjackPayout',
        label: 'Blackjack pays',
        options: [
          ['3:2', '3:2'],
          ['6:5', '6:5'],
        ],
      },
      {
        kind: 'segment',
        key: 'doubleRule',
        label: 'Double down',
        options: [
          ['any', 'Any'],
          ['9-11', '9–11'],
          ['off', 'Off'],
        ],
      },
      {
        kind: 'segment',
        key: 'splitAllowed',
        label: 'Split allowed',
        options: [
          ['true', 'On'],
          ['false', 'Off'],
        ],
      },
    ],
  },
];

/** Each control knows how to show the server's value and whether it can be edited. */
interface Control {
  sync(settings: PublicSettings, editable: boolean, force: boolean): void;
}

const controls: Control[] = [];

function sendSetting(patch: Partial<Settings>): void {
  send({ type: 'update_settings', settings: patch });
}

/** Puts the server's settings back into the inputs, e.g. after a rejected change. */
export function resyncSettings(): void {
  if (app.state) syncSettings(app.state, true);
}

function segmented(label: string, options: [string, string][], onPick: (value: string) => void) {
  const box = h('div', 'segmented');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', label);
  const buttons = options.map(([value, text]) => {
    const b = h('button', undefined, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = value;
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-checked') !== 'true') onPick(value);
    });
    box.append(b);
    return b;
  });
  return {
    el: box,
    set(value: string, editable: boolean) {
      for (const b of buttons) {
        b.setAttribute('aria-checked', String(b.dataset.value === value));
        b.disabled = !editable;
      }
    },
  };
}

function numberInput(f: { min?: number; max?: number }): HTMLInputElement {
  const inp = h('input', 'num-input num');
  inp.type = 'number';
  inp.inputMode = 'numeric';
  if (f.min !== undefined) inp.min = String(f.min);
  if (f.max !== undefined) inp.max = String(f.max);
  return inp;
}

function withUnit(inp: HTMLInputElement, unit: string | undefined): HTMLElement {
  if (!unit) return inp;
  const wrap = h('span', 'with-unit');
  wrap.append(inp, h('span', 'unit', unit));
  return wrap;
}

function buildField(f: Field): HTMLElement {
  const row = h('div', 'setting-row');
  const id = `setting-${f.key}`;
  const label = h('label', 'setting-label', f.label);
  label.htmlFor = id;
  row.append(label);
  const holder = h('div', 'setting-control');
  row.append(holder);

  if (f.kind === 'segment') {
    label.removeAttribute('for');
    label.id = id;
    const seg = segmented(f.label, f.options, (v) =>
      sendSetting({ [f.key]: f.key === 'dealerHitsSoft17' || f.key === 'splitAllowed' ? v === 'true' : v } as Partial<Settings>),
    );
    holder.append(seg.el);
    controls.push({ sync: (s, editable) => seg.set(String(s[f.key as keyof PublicSettings]), editable) });
  } else if (f.kind === 'password') {
    const inp = h('input', 'text-input');
    inp.id = id;
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.maxLength = 100;
    inp.addEventListener('change', () => sendSetting({ password: inp.value }));
    holder.append(inp);
    controls.push({
      sync(s, editable) {
        inp.disabled = !editable;
        if (!editable) {
          inp.value = s.passwordSet ? 'Set' : 'None';
          inp.placeholder = '';
        } else {
          if (inp.value === 'Set' || inp.value === 'None') inp.value = '';
          inp.placeholder = s.passwordSet ? 'Set. Type to change' : 'None';
        }
      },
    });
  } else if (f.kind === 'turn') {
    const inp = numberInput(SETTINGS_LIMITS.turnSeconds);
    inp.id = id;
    inp.addEventListener('change', () => {
      const n = Number(inp.value);
      if (!Number.isInteger(n)) return toast('Turn time must be a whole number of seconds');
      sendSetting({ turnSeconds: n });
    });
    const seg = segmented('Turn timer', [
      ['on', 'On'],
      ['off', 'Off'],
    ], (v) => sendSetting({ turnSeconds: v === 'off' ? null : Number(inp.value) || 30 }));
    const unitBox = withUnit(inp, 's');
    holder.append(seg.el, unitBox);
    controls.push({
      sync(s, editable, force) {
        const off = s.turnSeconds === null;
        seg.set(off ? 'off' : 'on', editable);
        unitBox.hidden = off;
        inp.disabled = !editable;
        if (document.activeElement !== inp || force) inp.value = off ? '' : String(s.turnSeconds);
      },
    });
  } else {
    const inp = numberInput(f);
    inp.id = id;
    inp.addEventListener('change', () => {
      const n = Number(inp.value);
      if (inp.value === '' || !Number.isInteger(n)) {
        toast(`${f.label} must be a whole number`);
        resyncSettings();
        return;
      }
      sendSetting({ [f.key]: n } as Partial<Settings>);
    });
    holder.append(withUnit(inp, f.unit));
    controls.push({
      sync(s, editable, force) {
        inp.disabled = !editable;
        if (document.activeElement !== inp || force) inp.value = String(s[f.key as keyof PublicSettings]);
      },
    });
  }
  return row;
}

/** Builds the settings controls and wires the waiting room buttons. Call once. */
export function initWaiting(): void {
  const box = $('settings-grid');
  for (const g of GROUPS) {
    const group = h('div', 'setting-group');
    group.append(h('h3', 'group-title', g.title));
    for (const f of g.fields) group.append(buildField(f));
    box.append(group);
  }
  $('ready-btn').addEventListener('click', () => {
    const self = me();
    if (self) send({ type: 'set_ready', ready: !self.ready });
  });
  $('start-btn').addEventListener('click', () => send({ type: 'start_game' }));
  $('reset-btn-wait').addEventListener('click', resetChips);
  $('share-btn').addEventListener('click', () => void shareLink());
  $('share-copy').addEventListener('click', () => void copyShareLink());
  $<HTMLInputElement>('share-link').addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
}

// ------------------------------------------------------------------- share

/** Copies the invite link, falling back to selecting it for a manual copy. */
async function copyShareLink(): Promise<void> {
  const field = $<HTMLInputElement>('share-link');
  try {
    await navigator.clipboard.writeText(field.value);
    toast('Invite link copied');
  } catch {
    field.focus();
    field.select();
    toast('Press Ctrl+C to copy the link');
  }
}

/** Asks the server for its public address and shows it as a link to send to friends. */
async function shareLink(): Promise<void> {
  const btn = $<HTMLButtonElement>('share-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/public-ip');
    const body = (await res.json().catch(() => ({}))) as { ip?: string; port?: number; error?: string };
    if (!res.ok || !body.ip || !body.port) throw new Error(body.error ?? 'Could not find your public IP');
    const host = body.ip.includes(':') ? `[${body.ip}]` : body.ip;
    $<HTMLInputElement>('share-link').value = `http://${host}:${body.port}`;
    $('share-port').textContent = String(body.port);
    $('share-box').hidden = false;
    await copyShareLink();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not find your public IP');
  } finally {
    btn.disabled = false;
  }
}

/** Copies the server's settings into the controls, leaving the one being typed in alone unless forced. */
function syncSettings(s: TableState, force = false): void {
  const editable = isHost() && !s.started && s.phase === 'waiting';
  for (const c of controls) c.sync(s.settings, editable, force);
}

// ------------------------------------------------------------- player list

function playerRow(s: TableState, p: PlayerView, host: boolean): HTMLElement {
  const li = h('li', 'player-row');
  if (!p.connected) li.classList.add('away');
  const avatar = h('span', 'avatar', p.name.slice(0, 1).toUpperCase());
  if (p.id === s.hostId) avatar.classList.add('is-host');
  const who = h('div', 'who');
  const nameLine = h('div', 'who-name');
  nameLine.append(h('span', 'name', p.name));
  if (p.id === app.myId) nameLine.append(h('span', 'tag', 'You'));
  if (p.id === s.hostId) nameLine.append(h('span', 'tag tag-accent', 'Host'));
  if (!p.connected) nameLine.append(h('span', 'tag', 'Away'));
  const earned = ` · earnings ${fmtSigned(p.earnings)}`;
  who.append(nameLine, h('span', p.earnings < 0 ? 'who-chips has-debt num' : 'who-chips num', `${fmt(p.chips)} chips${earned}`));
  const status = h('span', p.ready ? 'ready-pill is-ready' : 'ready-pill', p.ready ? 'Ready' : 'Not ready');
  li.append(avatar, who, status);
  if (host && p.id !== app.myId) {
    const kick = h('button', 'icon-btn kick-btn');
    kick.type = 'button';
    kick.title = `Kick ${p.name}`;
    kick.setAttribute('aria-label', `Kick ${p.name}`);
    kick.append(icon('close'));
    kick.addEventListener('click', () => confirmKick(p));
    li.append(kick);
  }
  return li;
}

export function renderWaiting(s: TableState, self: PlayerView): void {
  const host = isHost();
  $('wait-hint').textContent = host
    ? 'You are the host. Set up the table and start when players are ready.'
    : 'Waiting for the host to start the game.';
  $('settings-note').textContent = host ? '' : 'Only the host can change these';
  $('player-count').textContent = `${s.players.length} / ${s.settings.maxPlayers}`;

  $('player-list').replaceChildren(...s.players.map((p) => playerRow(s, p, host)));

  const ready = $<HTMLButtonElement>('ready-btn');
  ready.replaceChildren(icon('check'), self.ready ? 'Ready' : "I'm ready");
  ready.classList.toggle('is-ready', self.ready);
  ready.classList.toggle('for-host', host);
  ready.setAttribute('aria-pressed', String(self.ready));
  ready.title = self.ready ? 'Click to mark yourself not ready' : '';
  $('start-row').hidden = !host;
  const anyReady = s.players.some((p) => p.ready);
  $<HTMLButtonElement>('start-btn').disabled = !anyReady;
  $('start-hint').textContent = anyReady ? '' : 'At least one player must be ready.';
  syncSettings(s);
}
