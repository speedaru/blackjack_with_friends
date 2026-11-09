import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionName, HandView, PlayerView, ServerMsg, TableState } from '../shared/types.js';
import { isHiddenCard } from '../shared/types.js';
import type { ServerOptions } from '../server/index.js';
import type { Timing } from '../server/table.js';
import { betOf, cards, createHarness, sleep, waitUntil, type TestClient } from './helpers.js';

const h = createHarness();
let expectedLogs = 0;

afterEach(async () => {
  const logs = h.logs.splice(0);
  await h.cleanup();
  // Nothing may be logged as an error or warning during a normal test.
  expect(logs.length).toBe(expectedLogs);
  expectedLogs = 0;
});

/** Boots a server with a host (Alex) and a guest (Bob), both joined and ready, game not started. */
async function twoPlayers(options: Partial<ServerOptions> = {}) {
  const { srv, dataDir } = await h.boot(options);
  const alex = await h.client(srv);
  const bob = await h.client(srv);
  expect((await alex.join('Alex', { hostToken: srv.hostToken })).type).toBe('joined');
  expect((await bob.join('Bob')).type).toBe('joined');
  alex.send({ type: 'set_ready', ready: true });
  bob.send({ type: 'set_ready', ready: true });
  await alex.waitForState((s) => s.players.every((p) => p.ready));
  return { srv, dataDir, alex, bob };
}

const standAlways = (): ActionName => 'stand';

function allMessages(...clients: TestClient[]): ServerMsg[] {
  return clients.flatMap((c) => c.all);
}

describe('playing rounds', () => {
  it('2 clients join, bet and play 3 rounds without errors', async () => {
    const { alex, bob } = await twoPlayers();
    const hitBelow17 = (p: HandView): ActionName => (p.total < 17 ? 'hit' : 'stand');
    alex.autoPlay(10, hitBelow17);
    bob.autoPlay(10, hitBelow17);
    const settles = alex.collectSettles();
    const bobSettles = bob.collectSettles();
    alex.send({ type: 'start_game' });

    await waitUntil(() => settles.has(3) && bobSettles.has(3), 8000, 'round 3');
    expect(alex.errors).toEqual([]);
    expect(bob.errors).toEqual([]);

    // Chips follow the round results exactly.
    for (const [c, seen] of [[alex, settles], [bob, bobSettles]] as const) {
      let chips = 1000;
      const roundResults = c.all.filter((m): m is Extract<ServerMsg, { type: 'round_result' }> => m.type === 'round_result');
      expect(roundResults.length).toBeGreaterThanOrEqual(3);
      for (const r of roundResults.filter((x) => x.round <= 3)) {
        const mine = r.results.find((x) => x.playerId === c.id);
        if (mine) chips += mine.delta;
        expect(c.me(seen.get(r.round)!).chips, `${c.me().name} after round ${r.round}`).toBe(chips);
      }
    }
  });

  it('two players play 5 full rounds and the chip counts are exact after each', async () => {
    // Deal order per round: Alex, Bob, dealer up, Alex, Bob, dealer hole, then any draws.
    const rigged = cards(
      [
        '10 10 10 9 6 7D', // 1: Alex 19 beats dealer 17, Bob 16 loses
        'A 8 6 K 7 10 9', // 2: Alex blackjack, dealer busts (Bob 15 wins)
        '10 10 9 2 8 9 10', // 3: Alex 12 hits and busts, Bob 18 pushes dealer 18
        '5 9 10 6 9 8 10', // 4: Alex 11 doubles to 21 and wins, Bob 18 pushes
        '10 A A 9 K K', // 5: dealer blackjack, Alex 19 loses, Bob blackjack pushes
      ].join(' '),
    );
    const { alex, bob } = await twoPlayers({ rigged });
    alex.autoPlay(100, (p) => (p.cards.length === 2 && p.total === 11 ? 'double' : p.total <= 12 ? 'hit' : 'stand'));
    bob.autoPlay(50, standAlways);
    const settles = alex.collectSettles();
    alex.send({ type: 'start_game' });

    const expected: [number, number][] = [
      [1100, 950],
      [1250, 1000],
      [1150, 1000],
      [1350, 1000],
      [1250, 1000],
    ];
    for (let round = 1; round <= 5; round++) {
      await waitUntil(() => settles.has(round), 6000, `round ${round}`);
      const s = settles.get(round)!;
      const [a, b] = expected[round - 1]!;
      expect(alex.me(s).chips, `Alex after round ${round}`).toBe(a);
      expect(bob.me(s).chips, `Bob after round ${round}`).toBe(b);
    }
    const last = settles.get(5)!;
    expect(alex.me(last).hands[0]!.outcome).toBe('loss');
    expect(bob.me(last).hands[0]!.outcome).toBe('push');
    expect(alex.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it('hides the hole card until it is revealed and never sends the host token', async () => {
    const rigged = cards('10 10 10 9 6 7D');
    const { srv, alex, bob } = await twoPlayers({ rigged });
    alex.autoPlay(100, standAlways);
    bob.autoPlay(50, standAlways);
    const settles = alex.collectSettles();
    alex.send({ type: 'start_game' });
    await waitUntil(() => settles.has(1), 6000, 'round 1');

    const holeCard = { rank: '7', suit: 'D' };
    for (const c of [alex, bob]) {
      const states = c.all.filter((m): m is TableState => m.type === 'table_state' && m.round === 1);
      let sawHidden = false;
      for (const s of states) {
        const covered = s.phase === 'dealing' || s.phase === 'player_turns';
        if (!covered) continue;
        const dealt = s.dealer.cards;
        if (dealt.length > 1) {
          expect(isHiddenCard(dealt[1]!)).toBe(true);
          sawHidden = true;
        }
        // The hole card must not appear anywhere in the message, not only in the dealer's cards.
        const text = JSON.stringify(s);
        expect(text.includes(JSON.stringify(holeCard))).toBe(false);
        expect(text.includes('"rank":"7","suit":"D"')).toBe(false);
      }
      expect(sawHidden).toBe(true);
    }
    // After the reveal the real card is there.
    const revealed = settles.get(1)!;
    expect(revealed.dealer.cards[1]).toEqual(holeCard);

    const everything = JSON.stringify(allMessages(alex, bob));
    expect(everything.includes(srv.hostToken)).toBe(false);
  });
});

describe('host and settings', () => {
  it("shows the host's setting changes to the other player and locks them after Start", async () => {
    const { srv, alex, bob } = await twoPlayers();
    alex.send({
      type: 'update_settings',
      settings: { minBet: 25, decks: 2, dealerHitsSoft17: true, blackjackPayout: '6:5', doubleRule: '9-11', password: 'secret', turnSeconds: null },
    });
    const s = await bob.waitForState((st) => st.settings.minBet === 25);
    expect(s.settings).toMatchObject({
      decks: 2,
      dealerHitsSoft17: true,
      blackjackPayout: '6:5',
      doubleRule: '9-11',
      passwordSet: true,
      turnSeconds: null,
    });
    // The password itself is never sent.
    expect(JSON.stringify(allMessages(alex, bob)).includes('secret')).toBe(false);
    expect(alex.me(s).id).toBe(s.hostId);

    alex.autoPlay(25, standAlways);
    bob.autoPlay(25, standAlways);
    alex.send({ type: 'start_game' });
    await bob.waitForState((st) => st.started);

    const err = await alex.expectError({ type: 'update_settings', settings: { minBet: 50 } });
    expect(err.code).toBe('settings_locked');
    expect(bob.state!.settings.minBet).toBe(25);
    void srv;
  });

  it('rejects invalid settings and settings changes from a non-host', async () => {
    const { alex, bob } = await twoPlayers();
    expect((await bob.expectError({ type: 'update_settings', settings: { minBet: 50 } })).code).toBe('not_host');
    expect((await alex.expectError({ type: 'update_settings', settings: { minBet: 5000 } })).code).toBe('invalid_settings');
    expect((await alex.expectError({ type: 'update_settings', settings: { decks: 9 } })).code).toBe('invalid_settings');
    expect((await alex.expectError({ type: 'update_settings', settings: { minBet: 'ten' as unknown as number } })).code).toBe('invalid_settings');
    expect((await alex.expectError({ type: 'update_settings', settings: { maxPlayers: 1 } })).code).toBe('invalid_settings');
    expect((await bob.expectError({ type: 'start_game' })).code).toBe('not_host');
    expect(alex.state!.settings.minBet).toBe(10);
    expect('maxBet' in alex.state!.settings).toBe(false);
    expect(alex.state!.started).toBe(false);
  });

  it('needs a ready player before the host can start', async () => {
    const { srv } = await h.boot();
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    expect((await alex.expectError({ type: 'start_game' })).code).toBe('cannot_start');
    alex.send({ type: 'set_ready', ready: true });
    await alex.waitForState((s) => s.players[0]!.ready);
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.started);
    expect(s.phase).toBe('betting');
  });

  it('gives host controls only to a client with the host token, and restores them when it comes back', async () => {
    const { srv } = await h.boot({ timing: { holdMs: 150 } });
    const host = await h.client(srv);
    const guest = await h.client(srv);
    const fake = await h.client(srv);
    expect(((await host.join('Alex', { hostToken: srv.hostToken })) as { isHost: boolean }).isHost).toBe(true);
    expect(((await guest.join('Bob')) as { isHost: boolean }).isHost).toBe(false);
    expect(((await fake.join('Cy', { hostToken: 'not-the-token' })) as { isHost: boolean }).isHost).toBe(false);

    // The host's tab closes. The table keeps going and the host link brings the controls back.
    host.close();
    await guest.waitForState((s) => !s.players.some((p) => p.name === 'Alex'), 3000);
    const again = await h.client(srv);
    const reply = await again.join('Alex', { hostToken: srv.hostToken });
    expect((reply as { isHost: boolean }).isHost).toBe(true);
    again.send({ type: 'update_settings', settings: { minBet: 20 } });
    await guest.waitForState((s) => s.settings.minBet === 20);
  });
});

describe('joining and kicking', () => {
  it('rejects bad usernames, a wrong password and a name already at the table', async () => {
    const { srv, alex } = await twoPlayers();
    alex.send({ type: 'update_settings', settings: { password: 'pw' } });
    await alex.waitForState((s) => s.settings.passwordSet);

    const c = await h.client(srv);
    for (const bad of ['', '   ', 'x'.repeat(17), 'bad!name', 'semi;colon']) {
      const reply = await c.join(bad, { password: 'pw' });
      expect(reply).toMatchObject({ type: 'error', code: 'bad_username' });
    }
    expect(await c.join('Cy')).toMatchObject({ type: 'error', code: 'wrong_password' });
    expect(await c.join('Cy', { password: 'nope' })).toMatchObject({ type: 'error', code: 'wrong_password' });
    // Names match ignoring case.
    expect(await c.join('BOB', { password: 'pw' })).toMatchObject({ type: 'error', code: 'name_in_use', message: 'That name is in use' });
    expect(await c.join('alex', { password: 'pw', reconnectToken: 'guess' })).toMatchObject({ type: 'error', code: 'name_in_use' });
    expect((await c.join('Cy', { password: 'pw' })).type).toBe('joined');
    const s = await alex.waitForState((st) => st.players.length === 3);
    expect(s.players.map((p) => p.name)).toEqual(['Alex', 'Bob', 'Cy']);
  });

  it('lets a player come back to the same name only with their reconnect token', async () => {
    const { srv, bob } = await twoPlayers();
    const old = { id: bob.id, token: bob.token };
    bob.close();
    const again = await h.client(srv);
    const reply = await again.join('bob', { reconnectToken: old.token });
    expect(reply).toMatchObject({ type: 'joined', playerId: old.id });
  });

  it('kicks a player, who then can not rejoin with that username', async () => {
    const { srv, alex, bob } = await twoPlayers();
    expect((await bob.expectError({ type: 'kick_player', playerId: alex.id })).code).toBe('not_host');
    expect((await alex.expectError({ type: 'kick_player', playerId: alex.id })).code).toBe('bad_message');
    expect((await alex.expectError({ type: 'kick_player', playerId: 'nobody' })).code).toBe('unknown_player');

    alex.send({ type: 'kick_player', playerId: bob.id });
    await waitUntil(() => bob.kickedReason !== null, 3000, 'kicked message');
    await alex.waitForState((s) => s.players.length === 1);
    await waitUntil(() => bob.closed, 3000, 'kicked socket to close');

    const retry = await h.client(srv);
    expect(await retry.join('Bob')).toMatchObject({ type: 'error', code: 'kicked' });
    expect(await retry.join('BOB')).toMatchObject({ type: 'error', code: 'kicked' });
    expect((await retry.join('Someone Else')).type).toBe('joined');
  });

  it('keeps the connection usable after garbage input', async () => {
    const { srv } = await h.boot();
    const c = await h.client(srv);
    c.sendRaw('this is not json');
    c.sendRaw('{"no":"type"}');
    c.sendRaw('[1,2,3]');
    c.sendRaw('null');
    c.sendRaw(JSON.stringify({ type: 'place_bet', amount: 5 })); // before joining
    c.sendRaw(JSON.stringify({ type: 'join', username: 42 }));
    await waitUntil(() => c.errors.length >= 6, 3000, 'six errors');
    expect(c.errors.map((e) => e.code)).toEqual(['bad_message', 'bad_message', 'bad_message', 'bad_message', 'not_joined', 'bad_username']);
    expect((await c.join('Cy')).type).toBe('joined');
    expect((await c.expectError({ type: 'bogus' } as never)).code).toBe('bad_message');
  });

  it('lets a watcher take a seat when one frees up', async () => {
    const { srv } = await h.boot({ timing: { bettingMs: 250 } });
    const alex = await h.client(srv);
    const bob = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    alex.send({ type: 'update_settings', settings: { maxPlayers: 1 } });
    await alex.waitForState((s) => s.settings.maxPlayers === 1);
    const info = bob.all.find((m) => m.type === 'server_info');
    expect(info).toMatchObject({ seatsFree: true });
    await bob.join('Bob');
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    const s = await bob.waitForState((st) => st.phase === 'betting');
    expect(bob.me(s).seat).toBeNull();
    expect(alex.me(s).seat).toBe(0);
    expect((await bob.expectError({ type: 'place_bet', amount: 10 })).code).toBe('not_seated');

    alex.send({ type: 'leave' });
    const later = await bob.waitForState((st) => bob.me(st).seat === 0, 3000);
    expect(later.seats).toEqual([bob.id]);
  });
});

describe('rejected messages', () => {
  it('rejects out-of-turn actions, out-of-phase messages and bets outside the limits without changing anything', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { turnMs: 5000, bettingMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);

    // Betting phase
    expect((await bob.expectError({ type: 'action', action: 'hit' })).code).toBe('wrong_phase');
    expect((await bob.expectError({ type: 'place_bet', amount: 5 })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: 1001 })).code).toBe('insufficient_chips');
    expect((await bob.expectError({ type: 'place_bet', amount: 1_000_000 })).code).toBe('insufficient_chips');
    expect((await bob.expectError({ type: 'place_bet', amount: 12.5 })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: '50' as unknown as number })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: -50 })).code).toBe('bet_invalid');
    expect(bob.me().chips).toBe(1000);
    expect(betOf(bob.me())).toBe(0);

    alex.send({ type: 'place_bet', amount: 100 });
    await alex.waitForState((s) => betOf(alex.me(s)) === 100);
    expect((await alex.expectError({ type: 'place_bet', amount: 100 })).code).toBe('already_bet');
    expect(alex.me().chips).toBe(900);
    expect((await bob.expectError({ type: 'set_ready', ready: true })).code).toBe('wrong_phase');

    bob.send({ type: 'place_bet', amount: 50 });
    const turn = await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);

    // Player turns: Bob acts out of turn.
    const before = JSON.stringify(turn.players.map((p) => [p.id, p.hands, p.chips]));
    expect((await bob.expectError({ type: 'action', action: 'hit' })).code).toBe('not_your_turn');
    expect((await bob.expectError({ type: 'action', action: 'stand' })).code).toBe('not_your_turn');
    expect((await alex.expectError({ type: 'action', action: 'fly' as never })).code).toBe('bad_message');
    expect((await alex.expectError({ type: 'place_bet', amount: 10 })).code).toBe('wrong_phase');
    expect((await alex.expectError({ type: 'reset_chips' })).code).toBe('cannot_reset');
    expect((await bob.expectError({ type: 'update_settings', settings: { minBet: 1 } })).code).toBe('not_host');
    const after = JSON.stringify(bob.state!.players.map((p) => [p.id, p.hands, p.chips]));
    expect(after).toBe(before);
    expect(bob.state!.turn).toBe(alex.id);

    // Doubling is only valid when the rules allow it: Alex has 19, which is allowed under "any two cards".
    alex.send({ type: 'action', action: 'stand' });
    await bob.waitForState((s) => s.turn === bob.id);
    bob.send({ type: 'action', action: 'stand' });
    await bob.waitForState((s) => s.phase === 'settle');
  });

  it('rejects doubling when the rule is off or the chips are short', async () => {
    const rigged = cards('5 6 10 6 5 7'); // Alex 11 (6+5), dealer 17
    const { srv } = await h.boot({ rigged });
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    alex.send({ type: 'update_settings', settings: { doubleRule: 'off', startingChips: 100 } });
    await alex.waitForState((s) => s.settings.doubleRule === 'off');
    alex.send({ type: 'reset_chips' });
    await alex.waitForState((s) => alex.me(s).chips === 100);
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    expect(alex.me().hands[0]!.canDouble).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'double' })).code).toBe('action_not_allowed');
    alex.send({ type: 'action', action: 'stand' });
    await alex.waitForState((s) => s.phase === 'settle');
  });
});

describe('timers and disconnects', () => {
  it('stands an idle player when the turn timer runs out, and sits out a player who does not bet', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { bettingMs: 300, turnMs: 250 } });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 }); // Bob never bets

    const dealt = await alex.waitForState((s) => s.phase === 'player_turns');
    expect(betOf(bob.me(dealt))).toBe(0);
    expect(bob.me(dealt).hands).toEqual([]); // no bet, no hand
    expect(bob.me(dealt).chips).toBe(1000);
    expect(dealt.turn).toBe(alex.id);

    // Alex does nothing, so the timer stands for him.
    const settled = await alex.waitForState((s) => s.phase === 'settle', 4000);
    expect(alex.me(settled).hands[0]!.status).toBe('stood');
    expect(settled.log.some((l) => l.text.includes('Alex ran out of time'))).toBe(true);
    expect(alex.me(settled).chips).toBe(1100); // 19 against 17
    expect(bob.me(settled).chips).toBe(1000);
  });

  it("does not freeze the table when a player's tab closes during their turn", async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { turnMs: 250, holdMs: 3000 } });
    bob.autoPlay(50, standAlways);
    alex.send({ type: 'start_game' });
    alex.autoPlay(100, () => 'stand');
    // Alex bets, but closes the tab as soon as it is Alex's turn.
    let closed = false;
    alex.onState((s) => {
      if (!closed && s.phase === 'player_turns' && s.turn === alex.id) {
        closed = true;
        alex.close();
      }
    });
    const settled = await bob.waitForState((s) => s.phase === 'settle', 5000);
    expect(closed).toBe(true);
    expect(settled.players.find((p) => p.name === 'Alex')!.hands[0]!.status).toBe('stood');
    // The seat is held, not given away.
    expect(settled.players.find((p) => p.name === 'Alex')!.seat).toBe(0);
  });

  it('does not freeze either when the turn timer is off', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { holdMs: 250 } });
    alex.send({ type: 'update_settings', settings: { turnSeconds: null } });
    await bob.waitForState((s) => s.settings.turnSeconds === null);
    bob.autoPlay(50, standAlways);
    alex.send({ type: 'start_game' });
    let closed = false;
    alex.autoPlay(100, standAlways);
    alex.onState((s) => {
      if (!closed && s.phase === 'player_turns' && s.turn === alex.id) {
        closed = true;
        alex.close();
      }
    });
    const settled = await bob.waitForState((s) => s.phase === 'settle', 5000);
    expect(settled.players.find((p) => p.name === 'Alex')!.hands[0]!.status).toBe('stood');
  });

  it('returns a refreshed player to the same seat mid-round', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { srv, alex, bob } = await twoPlayers({ rigged, timing: { turnMs: 6000, bettingMs: 6000, holdMs: 3000 } });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    bob.send({ type: 'place_bet', amount: 50 });
    const mid = await bob.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    const before = bob.me(mid);
    const token = bob.token;
    const id = bob.id;

    bob.close(); // the page is refreshed
    await alex.waitForState((s) => s.players.find((p) => p.id === id)?.connected === false);
    const fresh = await h.client(srv);
    const reply = await fresh.join('Bob', { reconnectToken: token });
    expect(reply).toMatchObject({ type: 'joined', playerId: id });
    const after = await fresh.waitForState((s) => s.players.find((p) => p.id === id)?.connected === true);
    const bobAfter = after.players.find((p) => p.id === id)!;
    expect(bobAfter.seat).toBe(before.seat);
    expect(bobAfter.hands[0]!.cards).toEqual(before.hands[0]!.cards);
    expect(betOf(bobAfter)).toBe(50);

    // The refreshed client can carry on: Alex stands, then Bob stands.
    alex.send({ type: 'action', action: 'stand' });
    await fresh.waitForState((s) => s.turn === id);
    fresh.send({ type: 'action', action: 'stand' });
    await fresh.waitForState((s) => s.phase === 'settle');
  });

  it('frees the seat after the hold, and a later rejoin keeps the saved chips', async () => {
    const { srv, alex, bob } = await twoPlayers({ timing: { holdMs: 150 } });
    bob.close();
    await alex.waitForState((s) => s.players.length === 1, 3000);
    const again = await h.client(srv);
    expect((await again.join('Bob')).type).toBe('joined');
    expect(again.me().chips).toBe(1000);
  });
});

describe('chips and usernames', () => {
  it('keeps chips across a server restart, gives a new username the starting chips, and resets chips', async () => {
    const rigged = cards('10 10 9 7'); // single player: 19 against 17
    const first = await h.boot({ rigged });
    const alex = await h.client(first.srv);
    await alex.join('Alex', { hostToken: first.srv.hostToken });
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    alex.autoPlay(100, standAlways);
    const won = await alex.waitForState((s) => s.phase === 'settle');
    expect(alex.me(won).chips).toBe(1100);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))).toEqual({ Alex: { chips: 1100, earnings: 100 } });
    expect(existsSync(join(first.dataDir, 'players.json.tmp'))).toBe(false);

    // Restart the server on the same folder, with different starting chips.
    await first.srv.close();
    const second = await h.boot({}, first.dataDir);
    const host = await h.client(second.srv);
    await host.join('Host', { hostToken: second.srv.hostToken });
    host.send({ type: 'update_settings', settings: { startingChips: 5000 } });
    await host.waitForState((s) => s.settings.startingChips === 5000);

    const back = await h.client(second.srv);
    await back.join('ALEX'); // same name, other case
    expect(back.me().name).toBe('Alex');
    expect(back.me().chips).toBe(1100);

    const newcomer = await h.client(second.srv);
    await newcomer.join('Newbie');
    expect(newcomer.me().chips).toBe(5000);

    // Reset chips works in the waiting room and is saved.
    back.send({ type: 'reset_chips' });
    await back.waitForState((s) => back.me(s).chips === 5000);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8')).Alex).toBe(5000);
  });

  it('resets chips in the betting phase only before the player has bet', async () => {
    const { alex, bob } = await twoPlayers({ timing: { bettingMs: 3000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    bob.send({ type: 'reset_chips' });
    await sleep(50);
    expect(bob.errors).toEqual([]);
    bob.send({ type: 'place_bet', amount: 100 });
    await bob.waitForState((s) => betOf(bob.me(s)) === 100);
    expect((await bob.expectError({ type: 'reset_chips' })).code).toBe('cannot_reset');
    expect(bob.me().chips).toBe(900);
  });
});

describe('bet limits', () => {
  it('accepts any bet from the minimum up to the whole stack, with no maximum', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { bettingMs: 5000, turnMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    expect((await bob.expectError({ type: 'place_bet', amount: 9 })).code).toBe('bet_invalid');
    alex.send({ type: 'place_bet', amount: 750 }); // above the old 500 cap
    await alex.waitForState((s) => betOf(alex.me(s)) === 750);
    expect(alex.me().chips).toBe(250);
    bob.send({ type: 'place_bet', amount: 10 }); // the minimum itself
    await bob.waitForState((s) => betOf(bob.me(s)) === 10);
    expect(bob.me().chips).toBe(990);
  });
});

describe('all in', () => {
  it('flags a bet of the whole stack, logs it, and does not flag a smaller bet', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { bettingMs: 5000, turnMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 1000 }); // the whole stack
    bob.send({ type: 'place_bet', amount: 999 });
    const st = await alex.waitForState((s) => betOf(alex.me(s)) === 1000 && betOf(bob.me(s)) === 999);
    expect(alex.me(st).hands[0]!.allIn).toBe(true);
    expect(alex.me(st).chips).toBe(0);
    expect(bob.me(st).hands[0]!.allIn).toBe(false);
    expect(st.log.some((e) => e.text === 'Alex goes all in (1,000)')).toBe(true);
    expect(st.log.some((e) => e.text === 'Bob bets 999')).toBe(true);
  });

  it('refuses a bet above the stack, and a bet below the minimum', async () => {
    const { alex, bob } = await twoPlayers({ timing: { bettingMs: 5000 } });
    alex.send({ type: 'update_settings', settings: { minBet: 100 } });
    await alex.waitForState((s) => s.settings.minBet === 100);
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    expect((await bob.expectError({ type: 'place_bet', amount: 1001 })).code).toBe('insufficient_chips');
    expect((await bob.expectError({ type: 'place_bet', amount: 99 })).code).toBe('bet_invalid');
    expect(bob.me().chips).toBe(1000);
  });
});

// --------------------------------------------------------------- side bets

describe('side bets', () => {
  it('takes custom side bet amounts with the bet and pays them right after the deal', async () => {
    // Deal order: Alex, Bob, dealer up, Alex, Bob, hole.
    // Alex 8H 8H is a perfect pair (25:1); Bob 5D 7D with the 6D up card is a straight flush (40:1).
    const rigged = cards('8H 5D 6D 8H 7D 10S');
    const { alex, bob } = await twoPlayers({ rigged, timing: { bettingMs: 5000, turnMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100, sideBets: { pairs: 40, plus3: 10 } });
    const placed = await alex.waitForState((s) => betOf(alex.me(s)) === 100);
    expect(alex.me(placed).chips).toBe(850);
    expect(alex.me(placed).sideBets.map((sb) => [sb.kind, sb.bet])).toEqual([['pairs', 40], ['plus3', 10]]);
    expect(placed.log.some((e) => e.text === 'Alex bets 100 + Perfect Pairs 40 and 21+3 10')).toBe(true);
    bob.send({ type: 'place_bet', amount: 50, sideBets: { pairs: 0, plus3: 20 } });

    const st = await alex.waitForState((s) => s.phase === 'player_turns');
    const a = alex.me(st);
    expect(a.chips).toBe(850 + 40 + 1000);
    expect(a.earnings).toBe(990);
    expect(a.sideBets).toEqual([
      { kind: 'pairs', bet: 40, result: 'Perfect pair', delta: 1000 },
      { kind: 'plus3', bet: 10, result: null, delta: -10 },
    ]);
    const b = bob.me(st);
    expect(b.chips).toBe(930 + 20 + 800);
    expect(b.sideBets).toEqual([{ kind: 'plus3', bet: 20, result: 'Straight flush', delta: 800 }]);
    expect(st.log.some((e) => e.text === 'Alex: Perfect pair on Perfect Pairs, +1,000')).toBe(true);
    expect(st.log.some((e) => e.text === 'Alex loses 21+3')).toBe(true);
    expect(alex.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it('refuses side bets below the minimum, above the main bet, not whole, or not covered by the chips', async () => {
    const { alex, bob } = await twoPlayers({ timing: { bettingMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    const bad = async (sideBets: unknown, amount = 100) =>
      (await alex.expectError({ type: 'place_bet', amount, sideBets: sideBets as never })).code;
    expect(await bad({ pairs: 5 })).toBe('bet_invalid'); // below the minimum of 10
    expect(await bad({ plus3: 101 })).toBe('bet_invalid'); // above the main bet
    expect(await bad({ pairs: 12.5 })).toBe('bet_invalid');
    expect(await bad({ pairs: true })).toBe('bet_invalid');
    expect(await bad('yes')).toBe('bet_invalid');
    expect(await bad({ pairs: 400, plus3: 400 }, 400)).toBe('insufficient_chips');
    expect(alex.me().chips).toBe(1000);
    expect(alex.me().sideBets).toEqual([]);
  });

  it('counts side bets toward all in', async () => {
    const { alex, bob } = await twoPlayers({ timing: { bettingMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 500, sideBets: { pairs: 300, plus3: 200 } });
    const st = await alex.waitForState((s) => betOf(alex.me(s)) === 500);
    expect(alex.me(st).chips).toBe(0);
    expect(alex.me(st).hands[0]!.allIn).toBe(true);
    expect(st.log.some((e) => e.text === 'Alex goes all in (1,000) + Perfect Pairs 300 and 21+3 200')).toBe(true);
  });

  it('gives side bet stakes back to a player who leaves before the deal', async () => {
    const { srv, alex, bob } = await twoPlayers({ timing: { bettingMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    bob.send({ type: 'place_bet', amount: 100, sideBets: { pairs: 60 } });
    await alex.waitForState((s) => s.players.some((p) => p.id === bob.id && betOf(p) === 100));
    bob.send({ type: 'leave' });
    await alex.waitForState((s) => !s.players.some((p) => p.id === bob.id));
    const again = await h.client(srv);
    expect((await again.join('Bob')).type).toBe('joined');
    expect(again.me().chips).toBe(1000);
  });
});

// ------------------------------------------------------------------- split

/**
 * One player (Alex, the host) with 1000 chips who bets 100 and gets to act.
 * Deal order is: Alex, dealer up, Alex, dealer hole, then draws in the order they are used.
 */
async function soloTurn(
  riggedText: string,
  settings: Partial<TableState['settings']> = {},
  opts: { bet?: number; timing?: Partial<Timing> } = {},
) {
  const { srv } = await h.boot({ rigged: cards(riggedText), timing: opts.timing });
  const alex = await h.client(srv);
  await alex.join('Alex', { hostToken: srv.hostToken });
  if (Object.keys(settings).length > 0) {
    alex.send({ type: 'update_settings', settings });
    await alex.waitForState((s) =>
      Object.entries(settings).every(([k, v]) => (s.settings as unknown as Record<string, unknown>)[k] === v),
    );
    // Changed starting chips only apply to a fresh balance, so reset to pick them up.
    alex.send({ type: 'reset_chips' });
    await alex.waitForState((s) => alex.me(s).chips === s.settings.startingChips);
  }
  alex.send({ type: 'set_ready', ready: true });
  alex.send({ type: 'start_game' });
  await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
  alex.send({ type: 'place_bet', amount: opts.bet ?? 100 });
  await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
  return alex;
}

describe('split', () => {
  it('splits a pair into two hands, plays the left hand first and settles each hand separately', async () => {
    // Alex 8 8, dealer 10 7 (17). Split: left 8+3, right 8+7. Left doubles with a 10, right stands on 15.
    const alex = await soloTurn('8 10 8 7 3 7 10');
    expect(alex.me().canSplit).toBe(true);

    alex.send({ type: 'action', action: 'split' });
    const split = await alex.waitForState((s) => alex.me(s).hands.length === 2);
    const me = alex.me(split);
    expect(me.chips).toBe(800); // second bet of 100 taken
    expect(me.hands.map((x) => x.cards.map((c) => c.rank))).toEqual([['8', '3'], ['8', '7']]);
    expect(me.hands.map((x) => x.bet)).toEqual([100, 100]);
    expect(me.activeHand).toBe(0);
    expect(me.canSplit).toBe(false); // no re-splitting
    expect(me.hands[0]!.canDouble).toBe(true); // 11, double after split
    expect(me.hands[1]!.canDouble).toBe(false); // not the hand being played
    expect(split.turn).toBe(alex.id);

    alex.send({ type: 'action', action: 'double' });
    const second = await alex.waitForState((s) => alex.me(s).activeHand === 1);
    expect(alex.me(second).hands[0]).toMatchObject({ bet: 200, doubled: true, status: 'stood', total: 21 });
    expect(alex.me(second).chips).toBe(700);

    alex.send({ type: 'action', action: 'stand' });
    const settled = await alex.waitForState((s) => s.phase === 'settle');
    const [left, right] = alex.me(settled).hands;
    expect(left).toMatchObject({ outcome: 'win', delta: 200 }); // 21 beats 17, doubled bet
    expect(right).toMatchObject({ outcome: 'loss', delta: -100 }); // 15 loses to 17
    expect(alex.me(settled).chips).toBe(1100); // 1000 + 200 - 100

    const result = alex.all.find((m) => m.type === 'round_result');
    expect(result && result.type === 'round_result' ? result.results.map((r) => [r.hand, r.outcome, r.delta]) : []).toEqual([
      [0, 'win', 200],
      [1, 'loss', -100],
    ]);
  });

  it('pays a 21 on a split hand 1:1, not as a blackjack (K and 10 count as a pair)', async () => {
    // Alex K 10, dealer 9 8 (17). Split: left K+A = 21, right 10+9 = 19.
    const alex = await soloTurn('K 9 10 8 A 9');
    expect(alex.me().canSplit).toBe(true);
    alex.send({ type: 'action', action: 'split' });
    // The 21 stands by itself, so the right hand is up next.
    const split = await alex.waitForState((s) => alex.me(s).hands.length === 2 && alex.me(s).activeHand === 1);
    expect(alex.me(split).hands[0]).toMatchObject({ status: 'stood', total: 21 });

    alex.send({ type: 'action', action: 'stand' });
    const settled = await alex.waitForState((s) => s.phase === 'settle');
    const [left, right] = alex.me(settled).hands;
    expect(left).toMatchObject({ outcome: 'win', delta: 100 }); // not 150
    expect(right).toMatchObject({ outcome: 'win', delta: 100 });
    expect(alex.me(settled).chips).toBe(1200);
  });

  it('gives split aces one card each and stands them automatically', async () => {
    // Alex A A, dealer 9 8 (17). Split: left A+10 = 21, right A+5 = 16.
    const alex = await soloTurn('A 9 A 8 10 5');
    alex.send({ type: 'action', action: 'split' });
    const settled = await alex.waitForState((s) => s.phase === 'settle');
    const me = alex.me(settled);
    expect(me.hands.map((x) => x.cards.length)).toEqual([2, 2]);
    expect(me.hands.every((x) => x.status === 'stood')).toBe(true);
    expect(me.hands[0]).toMatchObject({ outcome: 'win', delta: 100 }); // 21 pays 1:1
    expect(me.hands[1]).toMatchObject({ outcome: 'loss', delta: -100 });
    expect(me.chips).toBe(1000);
    // Neither ace ever got a turn: no state has two hands while it is still the player's turn.
    const gaveTurn = alex.all.some(
      (m) => m.type === 'table_state' && m.phase === 'player_turns' && m.players.some((p) => p.hands.length === 2),
    );
    expect(gaveTurn).toBe(false);
  });

  it('does not re-split split aces that draw another ace', async () => {
    const alex = await soloTurn('A 9 A 8 A 5');
    alex.send({ type: 'action', action: 'split' });
    const settled = await alex.waitForState((s) => s.phase === 'settle');
    expect(alex.me(settled).hands.map((x) => x.total)).toEqual([12, 16]);
    expect(alex.me(settled).hands.every((x) => x.status === 'stood')).toBe(true);
  });

  it('refuses a split of different values', async () => {
    const alex = await soloTurn('10 9 5 8');
    expect(alex.me().canSplit).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'split' })).code).toBe('action_not_allowed');
    expect(alex.me().hands).toHaveLength(1);
    expect(alex.me().chips).toBe(900);
  });

  it('refuses a split when the setting is off', async () => {
    const alex = await soloTurn('8 10 8 7', { splitAllowed: false });
    expect(alex.me().canSplit).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'split' })).code).toBe('action_not_allowed');
  });

  it('refuses a split without chips for the second bet', async () => {
    const alex = await soloTurn('8 10 8 7', { startingChips: 100 }, { bet: 100 });
    expect(alex.me().chips).toBe(0);
    expect(alex.me().canSplit).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'split' })).code).toBe('action_not_allowed');
  });

  it('refuses a split after a hit', async () => {
    const alex = await soloTurn('2 10 2 7 2');
    alex.send({ type: 'action', action: 'hit' });
    await alex.waitForState((s) => alex.me(s).hands[0]!.cards.length === 3);
    expect(alex.me().canSplit).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'split' })).code).toBe('action_not_allowed');
  });

  it('refuses a second split even when both new hands are pairs', async () => {
    const alex = await soloTurn('8 10 8 7 8 8');
    alex.send({ type: 'action', action: 'split' });
    await alex.waitForState((s) => alex.me(s).hands.length === 2);
    expect(alex.me().hands.map((x) => x.cards.map((c) => c.rank))).toEqual([['8', '8'], ['8', '8']]);
    expect(alex.me().canSplit).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'split' })).code).toBe('action_not_allowed');
    expect(alex.me().hands).toHaveLength(2);
    expect(alex.me().chips).toBe(800);
  });

  it('rejects a split out of turn and in the wrong phase', async () => {
    const rigged = cards('8 8 10 8 8 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { bettingMs: 5000, turnMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    expect((await alex.expectError({ type: 'action', action: 'split' })).code).toBe('wrong_phase');
    alex.send({ type: 'place_bet', amount: 100 });
    bob.send({ type: 'place_bet', amount: 100 });
    await bob.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    expect((await bob.expectError({ type: 'action', action: 'split' })).code).toBe('not_your_turn');
    expect(bob.me().canSplit).toBe(false); // only on that player's own turn
    expect(bob.me().chips).toBe(900);
  });

  it('follows the 9-11 double-down setting for each hand after a split', async () => {
    // Left 8+3 = 11 (can double), right 8+7 = 15 (cannot).
    const alex = await soloTurn('8 10 8 7 3 7', { doubleRule: '9-11' });
    alex.send({ type: 'action', action: 'split' });
    await alex.waitForState((s) => alex.me(s).hands.length === 2);
    expect(alex.me().hands[0]!.canDouble).toBe(true);
    alex.send({ type: 'action', action: 'stand' });
    await alex.waitForState((s) => alex.me(s).activeHand === 1);
    expect(alex.me().hands[1]!.canDouble).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'double' })).code).toBe('action_not_allowed');
  });

  it('does not allow a double after split when doubling is off', async () => {
    const alex = await soloTurn('8 10 8 7 3 7', { doubleRule: 'off' });
    alex.send({ type: 'action', action: 'split' });
    await alex.waitForState((s) => alex.me(s).hands.length === 2);
    expect(alex.me().hands[0]!.canDouble).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'double' })).code).toBe('action_not_allowed');
  });

  it('restarts the turn timer for each hand', async () => {
    const alex = await soloTurn('8 10 8 7 3 7', {}, { timing: { turnMs: 5000, bettingMs: 5000 } });
    alex.send({ type: 'action', action: 'split' });
    const first = await alex.waitForState((s) => alex.me(s).hands.length === 2);
    await sleep(60);
    alex.send({ type: 'action', action: 'stand' });
    const second = await alex.waitForState((s) => alex.me(s).activeHand === 1);
    expect(second.deadline!).toBeGreaterThan(first.deadline! + 30);
  });

  it('stands both hands of an idle player when the turn timer runs out', async () => {
    const alex = await soloTurn('8 10 8 7 3 7', {}, { timing: { turnMs: 150, bettingMs: 5000 } });
    alex.send({ type: 'action', action: 'split' });
    const settled = await alex.waitForState((s) => s.phase === 'settle', 4000);
    expect(alex.me(settled).hands.map((x) => x.status)).toEqual(['stood', 'stood']);
    expect(settled.log.filter((l) => l.text.includes('ran out of time')).length).toBe(2);
    expect(alex.me(settled).chips).toBe(800); // 11 and 15 both lose to 17: 1000 - 200
  });
});

describe('shoe reshuffles', () => {
  it('counts reshuffles in table_state so clients can play a sound', async () => {
    const { srv } = await h.boot();
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    alex.send({ type: 'update_settings', settings: { decks: 1 } });
    await alex.waitForState((s) => s.settings.decks === 1);
    expect(alex.state!.shuffles).toBe(0);
    alex.send({ type: 'set_ready', ready: true });
    alex.autoPlay(10, () => 'stand');
    alex.send({ type: 'start_game' });
    // A single deck is 75% dealt after a few rounds, so the shoe is reshuffled before long.
    const st = await alex.waitForState((s) => s.shuffles >= 1, 12000);
    expect(st.shuffles).toBeGreaterThanOrEqual(1);
    expect(st.log.some((l) => l.text.includes('Shuffling a new shoe'))).toBe(true);
  });
});

describe('borrowing', () => {
  it('lets a player with no chips borrow a buy-in, keeps the earnings across a restart, and clears them on reset', async () => {
    const rigged = cards('10 10 8 9'); // Alex 18 against 19
    const first = await h.boot({ rigged, timing: { settleMs: 200, bettingMs: 5000, turnMs: 5000 } });
    const alex = await h.client(first.srv);
    await alex.join('Alex', { hostToken: first.srv.hostToken });
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);

    // With chips left there is nothing to borrow.
    expect((await alex.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');

    alex.send({ type: 'place_bet', amount: 1000 }); // all in, and lose
    await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    alex.send({ type: 'action', action: 'stand' });
    const lost = await alex.waitForState((s) => s.phase === 'settle');
    expect(alex.me(lost).chips).toBe(0);
    expect(alex.me(lost).earnings).toBe(-1000);

    // Not while results are showing, only while bets are being placed.
    expect((await alex.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);

    alex.send({ type: 'borrow' });
    const borrowed = await alex.waitForState((s) => alex.me(s).chips === 1000);
    expect(alex.me(borrowed).earnings).toBe(-1000); // the loss already put the earnings there, borrowing keeps them
    expect(borrowed.log.some((e) => e.text === 'Alex borrows 1,000')).toBe(true);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))).toEqual({
      Alex: { chips: 1000, earnings: -1000 },
    });

    // Chips in hand again, so a second loan is refused.
    expect((await alex.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');

    // The earnings survive a restart.
    await first.srv.close();
    const second = await h.boot({}, first.dataDir);
    const back = await h.client(second.srv);
    await back.join('Alex');
    expect(back.me().chips).toBe(1000);
    expect(back.me().earnings).toBe(-1000);

    // Resetting chips wipes them.
    back.send({ type: 'reset_chips' });
    await back.waitForState((s) => back.me(s).earnings === 0);
    expect(back.me().chips).toBe(1000);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8')).Alex).toBe(1000);
  });
});

describe('closing the game', () => {
  it('ends the game when the last player leaves, and only the host link can create a new one', async () => {
    const { srv } = await h.boot();
    const alex = await h.client(srv);
    const bob = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    await bob.join('Bob');
    alex.send({ type: 'update_settings', settings: { startingChips: 2000, minBet: 50 } });
    await alex.waitForState((s) => s.settings.minBet === 50);

    // The game stays open while someone is still at the table.
    alex.send({ type: 'leave' });
    await bob.waitForState((s) => s.players.length === 1);
    const stillOpen = await h.client(srv);
    expect(stillOpen.all.find((m) => m.type === 'server_info')).toMatchObject({ gameOpen: true });
    stillOpen.close();

    // A newcomer waiting on the join screen is told when the game ends.
    const waiting = await h.client(srv);
    bob.send({ type: 'leave' });
    await waitUntil(() => waiting.all.some((m) => m.type === 'server_info' && !m.gameOpen), 3000, 'game closed info');
    expect(bob.all.filter((m) => m.type === 'server_info').pop()).toMatchObject({ gameOpen: false });

    // Players without the host token can't join any more.
    const carol = await h.client(srv);
    expect(carol.all.find((m) => m.type === 'server_info')).toMatchObject({ gameOpen: false });
    const refused = await carol.join('Carol');
    expect(refused).toMatchObject({ type: 'error', code: 'game_closed' });

    // The host link creates a fresh game: default settings, empty log, round 0.
    const host = await h.client(srv);
    const joined = await host.join('Alex', { hostToken: srv.hostToken });
    expect(joined).toMatchObject({ type: 'joined', isHost: true });
    const fresh = host.state!;
    expect(fresh.phase).toBe('waiting');
    expect(fresh.round).toBe(0);
    expect(fresh.settings.minBet).toBe(10);
    expect(fresh.settings.startingChips).toBe(1000);
    expect(fresh.log.map((l) => l.text)).toEqual(['Alex joined']);
    await waitUntil(() => waiting.all.filter((m) => m.type === 'server_info').pop()?.type === 'server_info' && (waiting.all.filter((m) => m.type === 'server_info').pop() as { gameOpen: boolean }).gameOpen, 3000, 'game open info');

    // Now everyone may join again.
    expect(await carol.join('Carol')).toMatchObject({ type: 'joined' });
  });

  it('ends the game after the round when the last player leaves in the middle of a hand', async () => {
    const rigged = cards('10 10 9 7');
    const { srv } = await h.boot({ rigged, timing: { settleMs: 150, bettingMs: 5000, turnMs: 5000 } });
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    const late = await h.client(srv);
    alex.send({ type: 'leave' });
    // The round finishes first, then the empty table closes and the waiting client is told.
    await waitUntil(() => late.all.some((m) => m.type === 'server_info' && !m.gameOpen), 5000, 'game closed info');
    expect(await late.join('Late')).toMatchObject({ type: 'error', code: 'game_closed' });
  });
});

describe('withdrawing', () => {
  /** Boots a table where Alex loses everything, then waits for the next betting phase. */
  async function brokeAlex() {
    const rigged = cards('10 10 8 9'); // Alex 18 against 19
    const { srv } = await h.boot({ rigged, timing: { settleMs: 150, bettingMs: 5000, turnMs: 5000 } });
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    // Not in debt yet: the starting chips are not a loan.
    expect(alex.me().earnings).toBe(0);
    expect((await alex.expectError({ type: 'withdraw', amount: 1 })).code).toBe('cannot_withdraw');
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 1000 });
    await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    alex.send({ type: 'action', action: 'stand' });
    await alex.waitForState((s) => s.phase === 'settle');
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    return alex;
  }

  it('moves chips onto the earnings, never more than the chips or the debt, and only before betting', async () => {
    const alex = await brokeAlex();
    expect(alex.me()).toMatchObject({ chips: 0, earnings: -1000 });
    expect((await alex.expectError({ type: 'withdraw', amount: 1 })).code).toBe('cannot_withdraw'); // no chips

    alex.send({ type: 'borrow' });
    await alex.waitForState((s) => alex.me(s).chips === 1000);
    expect(alex.me().earnings).toBe(-1000);

    for (const amount of [0, -5, 1.5, 1001, Number.NaN]) {
      expect((await alex.expectError({ type: 'withdraw', amount })).code).toBe('cannot_withdraw');
    }

    // Half of it: the chips go down and the earnings come up by the same amount.
    alex.send({ type: 'withdraw', amount: 500 });
    const half = await alex.waitForState((s) => alex.me(s).chips === 500);
    expect(alex.me(half).earnings).toBe(-500);
    expect(half.log.some((e) => e.text === 'Alex withdraws 500')).toBe(true);

    // Nothing above what is left in chips, and the rest clears the debt.
    expect((await alex.expectError({ type: 'withdraw', amount: 501 })).code).toBe('cannot_withdraw');
    alex.send({ type: 'withdraw', amount: 500 });
    await alex.waitForState((s) => alex.me(s).earnings === 0);
    expect(alex.me().chips).toBe(0);
    expect((await alex.expectError({ type: 'withdraw', amount: 1 })).code).toBe('cannot_withdraw'); // not in debt any more
  });

  it('lets a player who withdrew everything borrow again, which puts them back in debt', async () => {
    const alex = await brokeAlex();
    alex.send({ type: 'borrow' });
    await alex.waitForState((s) => alex.me(s).chips === 1000);
    alex.send({ type: 'withdraw', amount: 1000 });
    await alex.waitForState((s) => alex.me(s).earnings === 0);
    expect(alex.me()).toMatchObject({ chips: 0, earnings: 0 });

    alex.send({ type: 'borrow' });
    await alex.waitForState((s) => alex.me(s).chips === 1000);
    expect(alex.me().earnings).toBe(-1000); // the new buy-in is owed
  });

  it('is refused once the player has bet', async () => {
    const alex = await brokeAlex();
    alex.send({ type: 'borrow' });
    await alex.waitForState((s) => alex.me(s).chips === 1000);
    alex.send({ type: 'withdraw', amount: 400 });
    await alex.waitForState((s) => alex.me(s).chips === 600);
    alex.send({ type: 'place_bet', amount: 100 });
    await alex.waitForState((s) => alex.me(s).hands[0]?.bet === 100);
    expect((await alex.expectError({ type: 'withdraw', amount: 100 })).code).toBe('cannot_withdraw');
  });
});
