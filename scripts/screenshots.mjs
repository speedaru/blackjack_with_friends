// Takes screenshots of every screen and phase at desktop and phone size.
// Run with `npm run screenshots` (it builds first). Output goes to ./screenshots (not committed).
//
// One real browser player ("Maya", the host) plays against three scripted bots over WebSocket.
// The deck is rigged so each run looks the same: Maya wins, Alex pushes, Sam busts, Riley wins.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { startServer } from '../dist/server/server/index.js';

const OUT = join(process.cwd(), 'screenshots');
const VIEWPORTS = {
  desktop: { width: 1280, height: 800, isMobile: false },
  phone: { width: 390, height: 844, isMobile: true },
  // Only when asked for by name: npm run screenshots -- laptop
  laptop: { width: 1024, height: 700, isMobile: false, optional: true },
};
const only = process.argv.slice(2);

/** "AH 6S 10" -> cards. A bare rank is a spade. */
function cards(text) {
  return text.split(/\s+/).filter(Boolean).map((t) => {
    const last = t.slice(-1);
    const hasSuit = 'SHDC'.includes(last) && t.length > 1;
    return { rank: hasSuit ? t.slice(0, -1) : t, suit: hasSuit ? last : 'S' };
  });
}

// Deal order: each player, dealer up, each player, dealer hole. Then draws in play order.
// Players: Maya, Alex, Sam, Riley.
const RIGGED = cards('AH 10S 8D KC 9C  6S 8C 6H 9D 7D  3C 10D 2S');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.id = '';
    this.waiters = new Set();
  }
  async open(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'joined') this.id = msg.playerId;
      if (msg.type === 'table_state') {
        this.state = msg;
        for (const w of [...this.waiters]) w();
      }
    });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  me() {
    return this.state?.players.find((p) => p.id === this.id);
  }
  waitFor(pred, what, timeout = 15000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.name}: timed out waiting for ${what} (phase ${this.state?.phase})`));
      }, timeout);
      const check = () => {
        if (this.state && pred(this.state)) {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolve(this.state);
        }
      };
      this.waiters.add(check);
    });
  }
  close() {
    this.ws.terminate();
  }
}

async function run(browser, label, vp) {
  const dataDir = mkdtempSync(join(tmpdir(), 'bj-shots-'));
  const server = await startServer({
    port: 0,
    dataDir,
    hostToken: 'shots',
    rigged: RIGGED,
    seed: 7,
    log: () => {},
    timing: { dealMs: 350, dealerStepMs: 2600, settleMs: 60_000, holdMs: 60_000, bettingMs: 120_000, turnMs: 30_000 },
  });
  const base = `http://localhost:${server.port}`;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  const shot = async (name) => {
    await sleep(750); // let animations finish
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.warn(`  ! ${label}/${name}: page is ${overflow}px wider than the viewport`);
    await page.screenshot({ path: join(OUT, `${label}-${name}.png`) });
    console.log(`  ${label}-${name}.png`);
  };

  /** Presses a shortcut key; falls back to clicking the button (and says so) when the key does nothing. */
  const pressOrClick = async (key, selector, done) => {
    await page.keyboard.press(key);
    for (let i = 0; i < 20 && !done(); i++) await sleep(50);
    if (!done()) {
      console.warn(`  ! ${label}: key "${key}" did nothing, clicking ${selector}`);
      await page.click(selector);
    }
  };

  const bots = [];
  let serverClosed = false;
  try {
    await page.goto(`${base}/?host=shots`);
    await page.waitForSelector('#join-name', { state: 'visible' });
    await shot('1-join');

    await page.fill('#join-name', 'Maya');
    await page.click('#join-btn');
    await page.waitForSelector('#screen-waiting:not([hidden])');

    for (const name of ['Alex', 'Sam', 'Riley']) {
      const b = new Bot(name);
      await b.open(server.port);
      b.send({ type: 'join', username: name });
      await b.waitFor((s) => s.players.some((p) => p.name === name), 'join');
      bots.push(b);
    }
    const [alex, sam, riley] = bots;
    alex.send({ type: 'set_ready', ready: true });
    sam.send({ type: 'set_ready', ready: true });
    await alex.waitFor((s) => s.players.filter((p) => p.ready).length === 2, 'ready');
    await shot('2-waiting');

    // The same room as a player who is not the host: settings are read only.
    const guestContext = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
    });
    const guest = await guestContext.newPage();
    await guest.goto(base);
    await guest.fill('#join-name', 'Jordan');
    await guest.click('#join-btn');
    await guest.waitForSelector('#screen-waiting:not([hidden])');
    await sleep(500);
    await guest.screenshot({ path: join(OUT, `${label}-2b-waiting-guest.png`) });
    console.log(`  ${label}-2b-waiting-guest.png`);
    await guest.click('#leave-btn-wait');
    await guestContext.close();
    await alex.waitFor((s) => s.players.length === 4, 'guest left');

    await page.click('#ready-btn');
    riley.send({ type: 'set_ready', ready: true });
    await alex.waitFor((s) => s.players.filter((p) => p.ready).length === 4, 'all ready');
    await page.click('#start-btn');
    await alex.waitFor((s) => s.phase === 'betting', 'betting');

    alex.send({ type: 'place_bet', amount: 50 });
    sam.send({ type: 'place_bet', amount: 25 });
    riley.send({ type: 'place_bet', amount: 100 });
    await alex.waitFor((s) => s.players.filter((p) => (p.hands[0]?.bet ?? 0) > 0).length === 3, 'bot bets');
    // Pick a chip, then click a circle on the felt: 150 on the main bet and 25 on Perfect Pairs.
    await page.click('.chip-btn[data-value="100"]');
    await page.click('.bet-circle[data-spot="main"]');
    await page.click('.chip-btn[data-value="25"]');
    await page.click('.bet-circle[data-spot="main"]');
    await page.click('.bet-circle[data-spot="main"]');
    await page.click('.bet-circle[data-spot="pairs"]');
    await shot('3-betting');

    await pressOrClick('Enter', '#confirm-bet', () => (alex.state.players.find((p) => p.name === 'Maya').hands[0]?.bet ?? 0) > 0);
    await alex.waitFor((s) => s.phase === 'player_turns', 'player turns');
    await shot('4-my-turn');

    await pressOrClick('h', '#hit-btn', () => alex.state.players.find((p) => p.name === 'Maya').hands[0]?.cards.length === 3);
    await alex.waitFor((s) => s.players.find((p) => p.name === 'Maya').hands[0]?.cards.length === 3, 'Maya hits');
    await shot('4b-my-turn-after-hit');
    await pressOrClick('s', '#stand-btn', () => alex.state.turn !== alex.state.players.find((p) => p.name === 'Maya').id);
    await alex.waitFor((s) => s.turn === alex.id, "Alex's turn");
    await sleep(1500); // the countdown visibly runs
    await shot('5-other-turn');

    alex.send({ type: 'action', action: 'stand' });
    await sam.waitFor((s) => s.turn === sam.id, "Sam's turn");
    sam.send({ type: 'action', action: 'hit' });
    await riley.waitFor((s) => s.turn === riley.id, "Riley's turn");
    riley.send({ type: 'action', action: 'stand' });
    await alex.waitFor((s) => s.phase === 'dealer_turn' && !s.dealer.cards.some((c) => c.hidden), 'dealer reveal');
    await shot('6-dealer-turn');

    await alex.waitFor((s) => s.phase === 'settle', 'settle', 20000);
    await shot('7-results');

    const logBtn = await page.$('#log-btn');
    if (logBtn) {
      await logBtn.click();
      await shot('8-log-open');
      await logBtn.click().catch(() => page.keyboard.press('Escape'));
      await sleep(300);
    }
    const rulesBtn = await page.$('#rules-btn');
    if (rulesBtn) {
      await rulesBtn.click();
      await shot('9-rules');
    }

    await server.close();
    serverClosed = true;
    await page.waitForSelector('#screen-lost:not([hidden])');
    await shot('10-connection-lost');
  } finally {
    if (errors.length) console.warn(`  ! ${label}: console errors:\n    ${errors.join('\n    ')}`);
    for (const b of bots) b.close();
    await context.close();
    if (!serverClosed) await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
try {
  for (const [label, vp] of Object.entries(VIEWPORTS)) {
    if (only.length ? !only.includes(label) : vp.optional) continue;
    console.log(`${label} ${vp.width}x${vp.height}`);
    await run(browser, label, vp);
  }
} finally {
  await browser.close();
}
