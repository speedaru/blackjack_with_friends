import type { ClientMsg, ServerMsg } from '../shared/types.js';
import { app, me, send, toast } from './app.js';
import { initBorrow, renderBorrow } from './borrow.js';
import { clearBusy, getPending, initControls, renderControls } from './controls.js';
import { $, storageGet, storageSet } from './dom.js';
import { hydrateIcons, icon } from './icons.js';
import { initPanels, renderLog, renderRules, resetPanels } from './panels.js';
import { isMuted, playLose, playPayout, playWin, setMuted, unlockAudio } from './sound.js';
import { renderTable, resetTable } from './table.js';
import { initWallet, renderWallet } from './wallet.js';
import { initWaiting, renderWaiting, resyncSettings } from './waiting.js';

// ------------------------------------------------------------------ session

interface Session {
  username: string;
  token: string;
  password: string;
}

const SESSION_KEY = 'bj.session';

function loadSession(): Session | null {
  try {
    const raw = storageGet(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.username !== 'string') return null;
    return { username: s.username, token: typeof s.token === 'string' ? s.token : '', password: typeof s.password === 'string' ? s.password : '' };
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  storageSet(SESSION_KEY, s ? JSON.stringify(s) : null);
}

/** The host link carries ?host=TOKEN. It is kept for this tab so a refresh stays host. */
const hostToken: string | null = (() => {
  const fromUrl = new URLSearchParams(location.search).get('host');
  if (fromUrl) storageSet('bj.host', fromUrl, sessionStorage);
  return fromUrl ?? storageGet('bj.host', sessionStorage);
})();

// -------------------------------------------------------------------- state

let joinAttempt: { username: string; password: string; auto: boolean } | null = null;
let kicked = false;
let lostNote: string | null = null;

type ScreenName = 'join' | 'waiting' | 'table' | 'lost' | 'kicked';
const SCREENS: ScreenName[] = ['join', 'waiting', 'table', 'lost', 'kicked'];

function showScreen(name: ScreenName | null): void {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
}

// --------------------------------------------------------------- connection

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}`);
  app.ws = sock;
  sock.onmessage = (ev) => {
    if (sock !== app.ws) return;
    try {
      handle(JSON.parse(String(ev.data)) as ServerMsg);
    } catch (err) {
      console.error('Bad message from server', err);
    }
  };
  sock.onclose = () => {
    if (sock !== app.ws) return;
    app.joined = false;
    if (kicked) return; // the kicked screen is already showing
    $('lost-note').textContent =
      lostNote ?? 'The server stopped or your connection dropped. Your chips are saved up to the last finished round.';
    showScreen('lost');
  };
  sock.onerror = () => {
    // onclose follows and shows the Connection lost screen.
  };
}

function doJoin(username: string, password: string, auto: boolean): void {
  joinAttempt = { username, password, auto };
  const session = loadSession();
  const token = session && session.username.toLowerCase() === username.toLowerCase() ? session.token : '';
  const msg: ClientMsg = { type: 'join', username, password };
  if (token) msg.reconnectToken = token;
  if (hostToken) msg.hostToken = hostToken;
  send(msg);
}

/** The join form follows whether a game is running: after everyone left, only the host can create a new one. */
function renderJoinPanel(gameOpen: boolean): void {
  const canCreate = !gameOpen && hostToken !== null;
  const blocked = !gameOpen && !canCreate;
  $('join-sub').textContent = gameOpen
    ? 'Play for fake chips. Pick a name to sit down.'
    : canCreate
      ? 'The last player left, so the game ended. Pick a name to create a new game.'
      : 'This game has ended. Ask the host to create a new game.';
  $('join-btn').textContent = gameOpen ? 'Join table' : canCreate ? 'Create new game' : 'Game ended';
  $<HTMLButtonElement>('join-btn').disabled = blocked || joinAttempt !== null;
  $<HTMLInputElement>('join-name').disabled = blocked;
}

function handle(msg: ServerMsg): void {
  switch (msg.type) {
    case 'server_info': {
      $('join-password-row').hidden = !msg.passwordRequired;
      renderJoinPanel(msg.gameOpen);
      if (app.joined) return;
      const session = loadSession();
      if (session && session.token && !joinAttempt && msg.gameOpen) {
        doJoin(session.username, session.password, true); // refresh or reconnect
      } else if (!joinAttempt) {
        $<HTMLInputElement>('join-name').value ||= session?.username ?? '';
        showScreen('join');
      }
      return;
    }
    case 'joined': {
      app.joined = true;
      app.myId = msg.playerId;
      lostNote = null;
      if (joinAttempt) {
        saveSession({ username: joinAttempt.username, token: msg.reconnectToken, password: joinAttempt.password });
      }
      joinAttempt = null;
      $('join-error').textContent = '';
      return;
    }
    case 'table_state': {
      app.prevState = app.state;
      app.state = msg;
      app.clockOffset = msg.serverNow - Date.now();
      render();
      return;
    }
    case 'round_result': {
      // With a split there are two results: the sound follows the net result.
      const mine = msg.results.filter((r) => r.playerId === app.myId);
      const net = mine.reduce((sum, r) => sum + r.delta, 0);
      if (net > 0) {
        playPayout();
        playWin();
      }
      else if (net < 0) playLose();
      return;
    }
    case 'kicked': {
      kicked = true;
      app.joined = false;
      const s = loadSession();
      if (s) saveSession({ ...s, token: '' });
      $('kicked-note').textContent = msg.reason;
      showScreen('kicked');
      return;
    }
    case 'error':
      return handleError(msg.code, msg.message);
  }
}

const JOIN_ERRORS = new Set(['bad_username', 'name_in_use', 'wrong_password', 'kicked', 'bad_message', 'game_closed']);

function handleError(code: string, message: string): void {
  if (!app.joined && joinAttempt) {
    const s = loadSession();
    if (s && (code === 'wrong_password' || code === 'name_in_use' || code === 'kicked')) {
      saveSession({ ...s, token: '', password: code === 'wrong_password' ? '' : s.password });
    }
    if (JOIN_ERRORS.has(code)) {
      joinAttempt = null;
      $('join-error').textContent = message;
      $<HTMLButtonElement>('join-btn').disabled = code === 'game_closed' && hostToken === null;
      showScreen('join');
      return;
    }
  }
  if (code === 'already_joined' && app.joined) {
    // Another tab took over this player. The server closes this connection next.
    lostNote = message;
    return;
  }
  if (code === 'invalid_settings' || code === 'settings_locked') {
    resyncSettings();
  }
  clearBusy();
  renderControls();
  toast(message);
}

// --------------------------------------------------------------------- join

$('join-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const username = $<HTMLInputElement>('join-name').value.trim();
  const password = $<HTMLInputElement>('join-password').value;
  $('join-error').textContent = '';
  if (!username) return;
  unlockAudio();
  doJoin(username, password, false);
});

function goToJoinScreen(): void {
  app.joined = false;
  app.myId = null;
  app.state = null;
  app.prevState = null;
  joinAttempt = null;
  resetTable();
  resetPanels();
  const s = loadSession();
  if (s) saveSession({ ...s, token: '' });
  $<HTMLInputElement>('join-name').value = s?.username ?? '';
  showScreen('join');
}

function leave(): void {
  send({ type: 'leave' });
  goToJoinScreen();
}

$('leave-btn-wait').addEventListener('click', leave);
$('leave-btn-table').addEventListener('click', leave);

$('retry-btn').addEventListener('click', () => {
  lostNote = null;
  joinAttempt = null;
  connect();
});

$('kicked-back').addEventListener('click', () => {
  kicked = false;
  goToJoinScreen();
  showScreen(null);
  connect();
});

// -------------------------------------------------------------------- sound

function updateMuteButton(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.mute-btn')) {
    btn.replaceChildren(icon(isMuted() ? 'soundOff' : 'soundOn'));
    btn.setAttribute('aria-label', isMuted() ? 'Unmute sound' : 'Mute sound');
    btn.title = isMuted() ? 'Unmute sound' : 'Mute sound';
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('.mute-btn')) {
  btn.addEventListener('click', () => {
    setMuted(!isMuted());
    updateMuteButton();
    unlockAudio();
  });
}
document.addEventListener('pointerdown', () => unlockAudio(), { once: true });
updateMuteButton();

// ------------------------------------------------------------------- render

function render(): void {
  const s = app.state;
  if (!s || !app.myId) return;
  clearBusy();
  const self = me();
  if (!self) return;
  if (s.phase === 'waiting') {
    showScreen('waiting');
    renderWaiting(s, self);
  } else {
    showScreen('table');
    renderControls(); // first, so a stale pending bet is cleared before the felt shows it
    renderTable(s, self, getPending());
    renderLog(s);
    renderRules(s);
  }
  renderWallet(s, self);
  renderBorrow(s, self);
}

// --------------------------------------------------------------------- init

hydrateIcons();
initWaiting();
initControls();
initBorrow();
initWallet();
initPanels();
showScreen(null);
connect();
