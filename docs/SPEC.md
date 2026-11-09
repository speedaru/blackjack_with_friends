# Multiplayer Blackjack — Build Spec v1

Nov 6, 2026 · @cocobanana67

## Goal and scope

A multiplayer blackjack game for a group of friends, played for fake chips. One friend hosts the server on their Windows PC, and the others join from a browser at the host's IP and port.

- The server runs exactly one table: a dealer controlled by the server and up to 6 players. There are no lobbies and no lobby codes.
- The host picks the table rules before the first round. They are locked once the game starts.
- Players join from a desktop or phone browser. The layout is built for desktop and must stay usable on a phone.
- No accounts and no per-player passwords. Chips are saved per username in a JSON file on the host's PC.
- No real money.
- The project has two phases. **Phase 1** is the browser version and is the one to build now. **Phase 2** wraps it in an Electron desktop app; it is described near the end and gets its own prompt later.

## Tech stack and project layout

The stack is Node.js with TypeScript on both ends. One process serves the web page and the WebSocket, and you start it with a single command.

- **Runtime:** Node.js 20 or newer, TypeScript everywhere.
- **Server:** Express for static files plus `ws` or Socket.IO for real-time messages. Pick one and say why in the plan.
- **Client:** plain HTML, CSS and TypeScript, built with Vite or no bundler. Pick one in the plan. No frontend framework.
- **Cards:** drawn in CSS or SVG in code, with no image files.
- **Sounds:** short `.mp3` effects from the CC0 Kenney Casino Audio pack, played with the Web Audio API (see `CREDITS.md`). Only the win and lose jingles are generated in code.
- **Tests:** Vitest.
- **Start:** `npm install && npm start` builds the client and starts the server on port 3000.

```
/shared   types.ts      message and table-state types used by both sides
/server   index.ts      HTTP + WebSocket entry point, host token, startup URLs
          table.ts      the one table: players, seats, settings, timers
          game.ts       pure rules engine, no networking
          deck.ts       shoe, shuffle, seedable random generator
          store.ts      chips saved per username in data/players.json
/client   index.html, main.ts, styles.css, sound.ts, public/sounds/*.mp3
/tests    game.test.ts, multiplayer.test.ts
/data     players.json  created on first run, ignored by git
```

- Keep `game.ts` free of networking code so it can be tested on its own. Use a seedable random generator so tests can deal known cards.
- Export a `startServer({ port, dataDir })` function from the server, and have `npm start` call it. Phase 2 will reuse it to run the server inside Electron.

## Game rules

V1 uses standard casino rules with one split, two side bets (see below), and no insurance or surrender. The host can change some rules before the first round.

| Rule | Value | Host can change |
| --- | --- | --- |
| Decks in the shoe | 5 | Yes, 1 to 8 |
| Reshuffle | When 75% of the shoe is dealt | No |
| Dealer on soft 17 | Stands | Yes: stands or hits |
| Blackjack payout | 3:2 | Yes: 3:2 or 6:5 |
| Dealer hole card | Dealer peeks for blackjack when showing an ace or a 10-value card | No |
| Double down | On any first two cards: the bet doubles and the player gets exactly one more card | Yes: any two cards, 9 to 11 only, or off |
| Split | A pair can be split once for a second bet equal to the first; see below | Yes: on or off, default on |
| Side bets | Perfect Pairs and 21+3, always available; each stakes the minimum bet. See below | No |
| Insurance, surrender | Not in v1 | No |

Hand values:

- Number cards count their number, face cards count 10, and an ace counts 11 unless that would bust the hand, in which case it counts 1.
- A hand with an ace counted as 11 is soft, and the UI shows it as, for example, "soft 17".
- Blackjack is an ace plus a 10-value card as the first two cards. It beats any other 21.
- Player blackjack against dealer blackjack is a push, and the bet is returned.
- A player who busts loses at once, even if the dealer busts later.
- Doubling needs enough chips to match the original bet.

Split:

- Allowed on the first two cards when both have the same value. Any two 10-value cards count, so K and 10 can be split.
- It costs a second bet equal to the original, and is not allowed if the player doesn't have enough chips.
- One split only: the new hands can't be split again.
- Each new hand gets a second card straight away (left hand first, then right hand), and the hands are played in turn, left hand first. The turn timer restarts for each hand.
- Double after split is allowed and follows the double-down setting, per hand.

Side bets:

- Placed together with the main bet, never on their own. Each one stakes exactly the minimum bet, and the player needs chips for the main bet (at least the minimum) plus every side bet. A bet that uses all the player's chips, side bets included, counts as all in.
- Both settle right after the deal, before the dealer peek, so a dealer blackjack doesn't change them. Winnings (and the stake) go straight back to the chips, and the result counts toward earnings. The log says `<name>: Perfect pair on Perfect Pairs, +250` or `<name> loses 21+3`.
- **Perfect Pairs** (the player's first two cards): perfect pair, same suit, 25:1; colored pair, same color and other suit, 12:1; mixed pair, other color, 5:1. Anything else loses. Only the same rank counts as a pair, so K and Q is not one.
- **21+3** (the player's first two cards plus the dealer's up card, as a three-card poker hand): suited trips 100:1, straight flush 40:1, three of a kind 30:1, straight 10:1, flush 5:1. Anything else loses. The ace plays low (A-2-3) or high (Q-K-A), but K-A-2 is not a straight.
- A player who leaves before the deal gets the side bet stakes back with the main bet. A split does not change side bets.
- Split aces get exactly one card each and stand automatically.
- A 21 on a split hand is a normal 21, not a blackjack, so it pays 1:1.
- Each hand is settled separately against the dealer.

## Host, joining and settings

The host is whoever runs the server. On startup the server creates a random host token, prints a host link such as `http://localhost:3000/?host=TOKEN`, and opens it in the default browser. Opening that link gives host controls. Everyone else who joins is a regular player.

Use a token rather than "connections from localhost". Tunnel traffic also arrives from localhost, so that check would make every tunnel player a host.

- **Join screen:** enter a username, plus the table password if the host set one, then Join.
- **Waiting room:** before the first round, it lists the players and whether each is ready. The host sees an editable settings panel and a Start button, which is enabled once at least one player is ready. Everyone else sees the settings read-only.
- **Settings:** locked once the host clicks Start, until the server restarts.
- **Joining a game in progress:** the player goes straight to the table and takes a free seat from the next round. If every seat is full, they watch until one frees up.
- **Kicking:** the host can kick any player. A kicked player sees a message and can't rejoin with that username until the server restarts.
- **The game ends when the last player leaves** (or is dropped after not coming back). The table is wiped: settings go back to the defaults, and the round counter, shoe, log and kick list are cleared. Chips and earnings stay saved per username. While the game is ended, `server_info` has `gameOpen: false`, the join screen says "This game has ended. Ask the host to create a new game.", and a join without the host token is refused with `game_closed`. Joining with the host link shows a "Create new game" button and starts a fresh game in the waiting room with that player as host. If the last player leaves in the middle of a hand, the game ends when the round is settled.
- **The host's own seat:** the host plays like everyone else. If the host's tab closes, the game continues, and reopening the host link restores host controls.
- **Ending the game:** stopping the server (Ctrl+C or closing its window) ends the game for everyone.

| Setting | Default | Allowed range |
| --- | --- | --- |
| Max players | 6 | 1 to 7 |
| Table password | None | Optional, any text |
| Starting chips | 1,000 | 100 to 100,000 |
| Minimum bet | 10 | 1 up to the starting chips. There is no maximum bet: a player may bet any amount from the minimum up to their own chips |
| Betting timer | 20 s; a player with no bet sits out the round | 10 to 60 s |
| Turn timer | 30 s; the player stands automatically when it runs out | 10 to 120 s, or off |
| Decks, dealer on soft 17, blackjack payout, double down, split allowed | As in Game rules | As in Game rules |

## Chips and usernames

Chips belong to a username, are saved on the host's PC, and survive server restarts. There are no passwords, which is fine among friends: anyone who types a username gets its chips.

- **File:** `data/players.json` maps each username to its chip count, or to `{ "chips": n, "earnings": n }` when the player's earnings are not 0 (`earnings` is left out when 0). A `debt` field from older files is ignored, because the earnings already include it. Usernames match ignoring case, and the display keeps the case first used.
- **New username:** starts with the starting-chips setting. A returning username keeps its saved chips, even if the host changed starting chips.
- **Saving:** after each round is settled and when a player leaves. Write to a temporary file and then rename it, so a crash never leaves a half-written file.
- **Reset chips:** a button that sets that player's chips back to the starting amount and their earnings back to 0, after a confirmation. It is available in the waiting room and in the betting phase before the player bets.
- **Earnings:** each player has one number that says where they stand, saved with their chips. It starts at 0 on a new player, and the starting chips are not a debt. It goes up and down with every settled hand (a doubled or split hand counts its full bet), down when the player borrows (see Out of chips), and up when they withdraw. Below 0 the player is "in debt": that is what they owe. Everyone's money is their own: nobody can change another player's chips or earnings. Reset chips sets earnings back to 0.
- **Wallet:** the player's own Balance (chips), Earnings (green above 0, red below) and a Withdraw button, shown top left of the table bar and next to the title in the waiting room, not next to the cards. Withdraw is only shown while earnings are below 0.
- **Withdraw:** a player in debt (earnings below 0) can take chips out of their balance to pay it down, in the waiting room or in the betting phase before they bet. The Withdraw button opens an in-page dialog with an amount field, a ½ button (half of the most they can withdraw) and a Max button (the smaller of their chips and what they owe), and previews the new earnings and balance. Withdrawing lowers chips and raises earnings by the same amount (earnings −2,000, withdraw 1,000, earnings −1,000), and logs `<name> withdraws 1,000`. The server refuses it with `cannot_withdraw` when the amount is not a whole number of at least 1, is above the chips or the debt, the player is not in debt, or it is the wrong time.
- **Out of chips:** a player whose chips are below the minimum bet cannot bet and sits out until they borrow. At the start of each betting phase they get an in-page prompt (not a browser dialog) offering to borrow a buy-in. "Borrow" adds the starting-chips amount to their chips and sets their earnings to at most minus that amount: a player who just lost everything is already at −1,000 and stays there, one who had withdrawn back to 0 drops to −1,000. It logs `<name> borrows 1,000`. "Not now" (or Esc, or a click outside) closes the prompt for that round; a Borrow chips button in the betting bar opens it again. Chips are never negative, and the loan is not paid back automatically: the player withdraws when they want to. Borrowing is refused unless betting is open and the player is seated, has not bet and has fewer chips than the minimum bet (`cannot_borrow`).
- **Same username twice:** a username already at the table can't join again, unless it's the same player reconnecting with their token.
- **Allowed usernames:** 1 to 16 characters made of letters, numbers, spaces, `-` and `_`.

## Round flow and turn order

Each round runs through seven phases in order and then starts again from betting. The server owns the current phase, and clients only display it.

1. **Betting:** each seated player bets anything from the minimum bet up to their own chips before the betting timer ends. Anyone who doesn't bet sits out the round.
2. **Deal:** one card face up to each player in seat order, then the dealer's up card, then a second card to each player, then the dealer's hole card face down. Cards are dealt about 300 ms apart. Side bets are settled as soon as the last card is down.
3. **Dealer peek:** if the up card is an ace or a 10-value card, the server checks for dealer blackjack. If the dealer has it, the hole card is revealed and the round skips to settle.
4. **Player turns:** in seat order, left to right. Each player chooses Hit, Stand, Double or Split until they stand, bust or reach 21. Blackjack and 21 stand automatically. After a split, the player plays the left hand to the end and then the right hand.
5. **Dealer turn:** reveal the hole card, then draw until 17 or more, following the soft-17 rule. If every player has busted, the dealer draws no cards.
6. **Settle:** each hand is settled on its own: a win pays 1:1, blackjack pays the set payout, a push returns the bet, and a loss takes it. Chips are saved, and results stay on screen for 2 s (one named constant, `ROUND_PAUSE_MS`, in `server/table.ts`).
7. **Next round:** reshuffle if 75% of the shoe has been dealt, seat any waiting players, then go back to step 1.

## Client/server message protocol

The server is the only source of truth. Clients send what the player wants to do, and the server replies with the full table state after every change.

Every message is JSON with a `type` field, and the types are defined once in `/shared/types.ts`.

**Client to server**

| Type | Payload | Allowed when |
| --- | --- | --- |
| `join` | username, password, reconnect token (optional), host token (optional) | Join screen, or automatically after a refresh |
| `leave` | none | Any time |
| `set_ready` | ready (true or false) | Waiting room |
| `update_settings` | settings | Host only, waiting room |
| `start_game` | none | Host only, at least one player ready |
| `place_bet` | amount, optional `sideBets` (`{ pairs?: true, plus3?: true }`) | Betting phase |
| `action` | hit, stand, double or split | That player's turn |
| `reset_chips` | none | Waiting room, or betting phase before that player bets |
| `borrow` | none | Betting phase, seated, no bet yet, chips below the minimum bet |
| `withdraw` | `amount` (whole number) | Waiting room, or betting phase before that player bets; earnings below 0 and chips above 0; at most the smaller of chips and debt |
| `kick_player` | playerId | Host only |

**Server to client**

| Type | Payload | Sent when |
| --- | --- | --- |
| `server_info` | whether a password is set, whether seats are free, current phase, whether a game is open (`gameOpen`) | As soon as a client connects |
| `joined` | playerId, reconnect token, isHost | After a join or reconnect |
| `table_state` | phase, settings, hostId, players (name, chips, ready, connected, and one hand, or two after a split, each with cards, total, bet, status, doubled, all-in flag and result; plus which hand is active and whether split is allowed now), seats, dealer cards, whose turn, timer deadline, a counter of shoe reshuffles | After every change |
| `round_result` | per hand (two entries for a player who split): win, loss, push or blackjack, plus chip change | End of each round |
| `kicked` | reason | The player was kicked |
| `error` | code, message | A rejected message |

Server rules:

- Check every message for the right phase, the right player's turn, host rights, a bet of at least the minimum and no more than the player's chips, whether the action (including split) is allowed right now, and enough chips. A rejected message gets an `error` reply and changes nothing.
- Never send the dealer's hole card to clients before it is revealed. Send it as a hidden card.
- Never send the host token to anyone. Clients only learn `isHost`.
- Send the full `table_state` after every change rather than partial updates, because it is simpler and harder to get wrong.
- Timers run on the server. Clients get the deadline as a timestamp and count down locally.

## UI screens

The game has three screens: join, waiting room and table. All of them are served by the host's server, so players only need a browser.

1. **Join:** game title, a username field, a password field shown only when the table has a password, and a Join button.
2. **Waiting room:** the player list with ready markers, the settings panel (editable for the host, read-only for others), Ready, Reset chips and Leave buttons, and the host's Start button.
3. **Table:**
   - An oval green felt table, with the dealer at the top showing cards and hand total.
   - Player seats in an arc along the bottom, with your own seat at the center. Each seat shows name, chips, bet, cards, total and a status such as BUST, BLACKJACK or WIN +100.
   - The current player's seat is highlighted, with a countdown bar for the turn timer.
   - Action bar with Hit, Stand, Double and Split (shortcuts H, S, D and P), greyed out when not allowed. Split is always shown.
   - After a split, both hands sit side by side in the player's spot, each with its own total badge, bet chip and result. The hand being played is highlighted.
   - Betting bar with the label "Min 10" (the minimum bet), chip buttons for 10, 25, 100 and 500, plus Clear, ½, ×2, All in and Confirm. A player who is out of chips sees Borrow chips instead of Confirm.
   - **Side bets:** a "Side bets" row in the betting bar with two toggle buttons, Perfect Pairs and 21+3, each showing its stake (+10). A toggle is disabled when turning it on would leave less than the minimum bet for the main bet. While side bets are on, the label reads "Min 10 · sides +20" and the bet box can hold at most the chips minus the side bets. The choice is remembered between rounds like the last bet, and side bets the chips no longer cover are switched off. All in puts the chosen side bets on and everything else on the main bet. Each seat shows small tags under the bet: `PAIRS 10` while waiting, then `PAIRS +250` in green on a win or a struck-through `21+3 −10` on a loss.
   - **Last bet:** each new betting round starts with the player's last bet already in the bet box (limited to their chips, and only if it is at least the minimum bet). They still press Confirm, and can change it first: Clear empties the box (and it stays empty that round), ½ halves the amount (rounded down), and ×2 doubles it. An all in counts as the last bet too. This is client-side only; the server is unchanged.
   - **All in:** the first click turns the button into a highlighted "Confirm all in (1,050)?" showing the player's full chips; a second click bets the whole stack and confirms it. It goes back to normal after 3 s without a second click, or when the player clicks anything else. It is enabled only when the player has at least the minimum bet. An all-in bet shows an "ALL IN" tag on its chip, and the log says "<name> goes all in (1,050)".
   - A banner with the round results.
   - An event log of recent actions, such as "Alex hits: 7, total 15".
   - For the host only, a kick button on each other player's seat.

Cards are white rounded rectangles with the rank and suit in the corners, red for hearts and diamonds. Face-down cards show a patterned back, and cards slide in from a shoe on the table.

- **Theme:** classic casino green.
- **Sounds:** recorded effects from the Kenney Casino Audio pack (CC0, `.mp3` so they play on iPhone Safari) for a card dealt (3 or 4 variants at random), the hole card flip, a reshuffle, a chip or bet placed, chips paid out on a win, and an all-in. The win and lose jingles are generated with the Web Audio API. Playback speed varies randomly between 0.95 and 1.05. A mute button remembers the choice in localStorage.
- **Phones:** the table must still work on a 390 px-wide phone held upright. Seats can shrink or stack.

## Hosting and connecting

In Phase 1 the host runs `npm start` on their Windows PC, and players open `http://HOST_IP:3000` in a browser. The same server delivers the page and the WebSocket, so there is nothing else to set up.

- The server listens on `0.0.0.0` so other machines can reach it. The port defaults to 3000, and the `PORT` environment variable overrides it.
- On startup, the server prints the host link and every LAN address, for example `http://192.168.1.42:3000`, so the host can copy one to share.
- The client opens its WebSocket to the same host and port it was loaded from. It uses `wss://` when the page was loaded over https, which tunnels need.

| Option | When it works | Setup |
| --- | --- | --- |
| Same Wi-Fi or LAN | Everyone on the same network | Allow Node through Windows Firewall the first time it runs (private networks) |
| Port forwarding | Over the internet | Forward TCP port 3000 on your router to your PC, and share your public IP |
| Tailscale | Over the internet, no router changes | Everyone installs Tailscale and joins your network; players use your Tailscale IP |
| Tunnel (cloudflared) | Over the internet, nothing for players to install | Run `cloudflared tunnel --url http://localhost:3000`; it prints a public https link to share |

Write a short `HOSTING.md` with these steps for Windows, including how to find your LAN IP with `ipconfig`.

## Edge cases and disconnects

No single player should be able to freeze or crash the table. When anything goes wrong, the round keeps going and the server stays up.

| Situation | Behavior |
| --- | --- |
| Player disconnects on their own turn | Seat is held; the turn timer runs out and they stand automatically |
| Player disconnects at any other time | Seat is held for 20 s, and they sit out betting while away |
| Page refresh or reconnect within 20 s | The client sends its saved reconnect token (kept in localStorage) and gets the same seat back |
| Reconnect after 20 s | Joins again with the same username and saved chips, and takes a seat from the next round |
| Host's tab closes | The game continues; reopening the host link restores host controls |
| Everyone has left | The game ends; only the host link can create a new one |
| The server stops | Players see a "Connection lost" screen with a Retry button; chips are kept up to the last settled round |
| Username already at the table | Join is rejected with "That name is in use" |
| Wrong table password | Join is rejected with "Wrong password" |
| Kicked player rejoins with the same username | Rejected until the server restarts |
| All seats are full | The player watches and gets a seat when one frees up |
| Double clicks or repeated messages | Buttons disable after a click, and the server ignores actions that aren't valid right now |
| Bet above the player's chips or the limits | Rejected with an error message |
| `players.json` is missing or unreadable | Start with no saved players, rename a broken file to `players.json.bak`, and log a warning |

## Phase 2: desktop app (build later)

Don't build this in Phase 1. Once Phase 1 works, a second prompt wraps it in an Electron app, and Phase 1's game code should not need to change.

- **One Windows app** with two buttons: Host game and Join game.
- **Host game:** calls `startServer` inside the app on port 3000 (changeable), opens the host link in the app window, and shows the LAN URLs to share. Closing the app stops the server.
- **Join game:** asks for the host's address as `host:port`, remembers the last one, and opens that table in the app window.
- **Browser players** still join exactly as in Phase 1, so friends without the app can play, including on phones.
- **Chips file:** lives in the app's user-data folder instead of `data/`.
- **Build:** a Windows portable `.exe` made with electron-builder, to upload to GitHub Releases. The exe isn't code-signed, so Windows SmartScreen warns on first launch ("More info", then "Run anyway"). Add this to `HOSTING.md`.

## Out of scope for v1

Don't build any of these.

- Insurance and surrender, which are planned for a later version
- More than one table, or lobbies with codes
- A separately deployed website
- Chat
- Accounts, per-player passwords, a database, or stats beyond chip counts
- Real money or payments of any kind
- Computer-controlled players; only the dealer is automated
- Anti-cheat beyond the server's own checks, since this is for friends
- The Electron app, until Phase 2

## Done-when checklist

Phase 1 is finished when every item below passes. Claude Code should check each one and report any it could not verify itself.

- [ ] `npm install && npm start` works in a fresh copy on Windows, and startup prints the host link and LAN URLs
- [ ] Rules engine tests pass for soft aces, blackjack, dealer on soft 17 both ways, 3:2 and 6:5 payouts, push, double, split (allowed and refused cases, split aces, 21 after split paying 1:1, double after split, each hand settled separately) and reshuffle
- [ ] An automated test with 2 simulated WebSocket clients joins, bets and plays 3 rounds without errors
- [ ] In two browser tabs, the host's setting changes show up for the other player, and settings lock after Start
- [ ] Two players can play 5 full rounds with the correct chip counts after each
- [ ] Chips survive a server restart, a new username gets the starting chips, and Reset chips works
- [ ] A player with no chips gets the borrow prompt, can borrow and keep playing, and the earnings drop to at most minus the buy-in and survive a restart
- [ ] A player in debt sees Withdraw top left, can withdraw an amount, ½ or Max, and the earnings go up by what was withdrawn
- [ ] A username already at the table is rejected, and a wrong password is rejected
- [ ] The host can kick a player, who then can't rejoin with that username
- [ ] The turn timer stands for an idle player, and the betting timer sits them out
- [ ] Refreshing mid-round returns the player to the same seat
- [ ] Closing a tab during that player's turn doesn't freeze the game
- [ ] Out-of-turn actions, non-host settings changes and bets above the limit are rejected without a crash
- [ ] The hole card never appears in a message before it's revealed, and the host token never appears in any message
- [ ] A phone on the same Wi-Fi joins through the LAN URL and can play
- [ ] Sounds play (including on iPhone Safari), and the mute button works
- [ ] No errors appear in the browser console or server log during the steps above

Phase 2 is finished when:

- [ ] electron-builder produces a Windows `.exe` that starts on a PC without Node installed
- [ ] A player using Host game in the app, a player using Join game in a second copy, and a browser player all play at one table

## Instructions for Claude Code

Save this doc as `SPEC.md` in an empty folder on your Windows PC, start Claude Code there, and paste the Phase 1 prompt. Once Phase 1 works and you've played a few rounds, paste the Phase 2 prompt.

**Phase 1 prompt**

```
Read SPEC.md in full. Build Phase 1 (the browser version) exactly as specified.
Do not build Phase 2 or anything listed under "Out of scope".

Work in this order:
1. Write a short plan: file layout, your choice of ws or Socket.IO and of
   Vite or no bundler, and any part of the spec you find unclear.
   Wait for my OK, then do the rest without stopping.
2. Shared types and the rules engine (game.ts, deck.ts) with Vitest tests.
   Run the tests and fix until they pass.
3. Server: the table, host token, settings, WebSocket handling, message
   checks, timers, reconnect, and chips saved in data/players.json.
4. Client: join, waiting room and table screens, and Web Audio sounds.
5. An automated test where 2 simulated WebSocket clients play 3 rounds.
6. HOSTING.md for Windows.
7. Go through the Done-when checklist for Phase 1. Run everything you can,
   then list what you could not verify and how I can check it by hand.

Rules:
- Use only the stack in the spec. Ask before adding other dependencies.
- Keep game logic out of the networking code.
- Where the spec is unclear, pick the simplest option and list your
  assumptions at the end.
```

**Phase 2 prompt**

```
Read SPEC.md, section "Phase 2: desktop app". Phase 1 is done and works.
Wrap it in an Electron app as specified, reusing startServer and the
existing client. Don't duplicate code or change game behavior.
Build the Windows portable .exe with electron-builder, then check the
Phase 2 items in the Done-when checklist. Tell me which ones you could
not verify yourself.
```

After each run, test it yourself with two browser tabs and then with your phone. Send fixes as short follow-up prompts, one problem each.
