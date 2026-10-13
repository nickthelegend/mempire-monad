# Judge round 2

An independent judge (a fresh agent that had not seen the code or the chat) was given only:
- the live URL;
- the public repo;
- `docs/PORTAL-COPY.md`;
- the official rubric.

It was told to judge like a skeptical Metropolis judge. Its verdict follows verbatim, then what was fixed, then the re-judge.

---

## Round 1 verdict (13 Oct, ~20:20 IST), verbatim

# Mempire — Judge Report (Monad Metropolis, Track 03)

Evidence: live app driven with Playwright (Chrome headless) at 1440×900 and 390×844 using one guest (`0x09C7ab577139069F88459ccD813eE38AcC954403`); public repo (clone of HEAD, CI green); `docs/PORTAL-COPY.md`; Monad testnet JSON-RPC; Sourcify.

## 1. Scores

### Main track

| Criterion | Score | Reason |
|---|---|---|
| Product quality | 6 | Polished art, onboarding landed a starter deck on-chain in 9.3 s with no console errors — but the only replay errors out, 11/12 stocks say "No live price", and the free path never touches the chain. |
| Technical excellence | 7 | 8 contracts with code on-chain and Sourcify "perfect" matches; 7702 tx is a real type-4 tx; deterministic lockstep sim; CI green. But only 1 match ever ran (`nextMatchId()`=2), meta frozen, indexer undeployed. |
| Monad integration | 7 | Visible: live `monadNewHeads` strip (voted ~290 ms / final ~575 ms), P256 `0x0100` check executed in 120 ms, staking `0x1000` read. The headline "every card is a tx" is not visible without staking, and their own logs show 0.9–1.4 s per card, not 300 ms. |
| Track fit (Social/Attention/Culture) | 5 | Memecoin fighters = good cultural hook, but social layer is empty: "no clans yet", leaderboard is 10 anonymous "Paper Hands" addresses; no sharing/spectating observed. |
| Innovation | 6 | "Market is the meta" is a fresh twist; the game itself is a Clash Royale clone. |

### Bounties (Req 40 / Tech 30 / Monad 20 / Innov 10)

| Bounty | Req | Tech | Monad | Innov | Reason |
|---|---|---|---|---|---|
| Chainlink CRE | 4 | 6 | 5 | 6 | One write only (tx `0x26b6bc97…b219`), sent by the contract owner `0x81e43B…7a96` to the CRE *simulation* forwarder `0xB9F7…d192` — this is `cre workflow simulate --broadcast`, not a deployed DON workflow. `MarketMeta.currentEpoch()` is still 2986491 while the current epoch is ~2986503, so "every epoch" is false. |
| Mera Best UX | 5 | 6 | 5 | 5 | Could not exercise the passkey path; guest path (similar UX) was smooth — one tap, deck + AUSD + gas without asking. Unproven to me: real PRF passkey, 30-min session. |
| Mera Many Keys | 3 | 5 | 7 | 5 | In-app P256 check uses a *separate throwaway* passkey ("Uses a separate P-256 passkey made for this check") and calls the precompile directly, not `PasskeyRegistry`; no tx to `PasskeyRegistry` seen. Locker claimed in SUBMISSION.md not visible in UI. "Same account on any device" unverifiable. |
| Privy | 3 | 5 | 4 | 4 | "Continue with email" modal does open and `/api/privy/config` returns a policy, but there is no tx or screen proving embedded wallet, gas sponsorship, or session-signer usage; the portal copy itself says it "turns on once the dashboard origins are allowed" (stale/self-contradicting). |
| Envio | 2 | 5 | 3 | 3 | Not deployed. Production JS (62 chunks) contains no GraphQL/indexer URL, so the "Live on Monad" panel never renders. Proof offered is "verify-local 52/52 on a fork". |

## 2. Claims I could not verify

1. **"Any match can be replayed from its on-chain plays and checked against the state hashes"** — false in the live app: Arena → ▶ REPLAY on the only match shows "Can't rebuild this match: the relay has no replay record for this match". Replay also depends on the relay, not purely the chain.
2. **"A CRE workflow … reaches consensus and writes … every epoch"** — one simulated broadcast from the owner EOA through the simulation forwarder; no DON deployment found; meta has not changed since (epoch 2986491 still current). Relay health shows `keeper.epoch: 0, hash: null`, so the Pyth keeper hasn't posted either.
3. **"Stake a dollar"** — the only staked match (#1) staked 0.01 MON (`stake`=0x2386f26fc10000), not AUSD; players `0x2641…4BCD` vs `0xf00f…682D` are the developer's own two "live-smoke guests". AUSD permit staking is "proven on the fork" only.
4. **"A live staked match was settled on chain"** — true (`0xa89f61a6…a492` succeeded on Arena; match 1 `metaEpoch`=2986491), but it is a scripted self-match; zero organic matches.
5. **"each card shows exec / final ms" / "300 ms … every card drop its own tx"** — not observable without a staked match; their own SPONSOR-COVERAGE says 0.9–1.4 s exec / 1.5–1.9 s final.
6. **Mera "one passkey prompt" / "same passkey restores same account on any device"** — not testable headless without creating a second account (budget rule).
7. **Privy embedded wallet / gas sponsorship / policy-limited session signer actually used** — no on-chain evidence.
8. **Envio "feeding the live feed and leaderboards"** — no indexer in production; `/api/live` (relay) returns `{"matches":[]}`.
9. **"live matches can be watched from the chain"** — nothing live to watch.
10. **Gasless chest** — tx `0xb0cec249…cc59` is real (type 4, `authorizationList` present), but the README and `docs/MONAD-NATIVE.md` still say "Proven on a Prague fork … testnet awaiting the go" — docs contradict the portal.
11. **PasskeyRegistry "12,773 gas vs 353,980 in Solidity"** — no tx or in-app display of this number.
12. **Leaderboard "money columns are chain-verified"** — shows 5 wins / 5 losses across 10 addresses although only one match exists on the current deployment; unexplained provenance.
13. **"BTC, MON, NVDA, BONK and 32 more"** — 11 of 12 stocks (AAPL, MSFT, GOOGL, SPY…) say "No live price" in Cards and can't be minted; Daily Shop still offers $GOOGL "no live price" for 0.01 MON.

## 3. Broken or confusing

- **First 60 s:** "Play as Guest" works well (deck landed in 9.3 s; on-chain I confirmed 8 NFTs, 10,000 AUSD, 0.4 MON). But the coach tour pops over the Arena immediately and its highlight ring around the bottom nav runs off the bottom of the viewport on desktop; header shows MON (◆ 0.4) but not the 10,000 AUSD you were just given, even though AUSD is the selected stake currency.
- **Replay of match #1 fails** (the only "won +0.018 MON ▶ REPLAY" item on Arena).
- **Meta numbers contradict:** Cards shows e.g. $UNI "+0.7% ▼ 1.3% today" (positive move, nerf); landing shows $BTC "+1.6% 24h → +0.2%" while $AVAX "-2.6% 24h → −2.7%" — 24h figure is live but the modifier is a stale snapshot; a first-time player can't reconcile them.
- **Practice end screen is self-contradictory:** "Practice match — no stake, no rake, nothing recorded" alongside "90 state hashes committed · settled by final-state signature".
- **Practice sends zero transactions** (0 `eth_sendRawTransaction` over 77 drags) — the free path never shows the core Monad claim.
- **Stalemate:** desktop practice went 0–0 into overtime with units clumping at bridges; on the phone a tower fell (0–1) with no slow-mo punch-in I could see.
- **Rate limiting:** repeated HTTP 429s from `testnet-rpc.monad.xyz` on load; heartbeat once sat at "CONNECTING… waiting for the next block".
- **Heartbeat block numbers are truncated to 4 digits** ("6449"), which reads like not-real block heights.
- **"Daily Shop" says "rotates in 1m 47s"** alongside "a new set each shop day".
- **Doc mismatches:** SUBMISSION.md still says "currently registered as 02", lists Kimi as a targeted bounty (portal says Kimi off), says "testnet awaiting the go"; tagline differs from portal; README says "`PasskeyRegistry` … is the fifth contract" / "all four contracts" with 8 deployed.

## 4. Dense or ugly screens

- **Desktop 1440×900, every screen:** the app is a 430 px phone column centered with two floating "BUFFED/NERFED" boards and large empty purple margins; battle view is a 430 px strip.
- **Phone 390×844, Landing:** the BUFFED/NERFED boards disappear entirely — the core "market is the meta" hook is invisible on mobile.
- **Phone + desktop, Cards:** long scroll — chests, Season Pass, Daily Shop, Your Cards, then 36 "price · 24h% ▼ x% today · Mint" rows with "No live price" repeated 11×; the densest screen.
- **Desktop, Empire:** Monad network panel copy (precompile addresses, Multicall3, "validator #101 · 11,000,000 MON staked · 0% commission") is developer-facing text inside a game UI.
- **Battle (both):** $MON card has no character art (just a "MO" coin icon); coach panel covers the enemy half on first drop.

## 5. The reason I'd vote no

The pitch is "every card is a Monad transaction, the market reshapes the meta every epoch, and any match is replayable from the chain" — but the live product shows a judge none of that: the chain has exactly one match ever (a 0.01 MON self-match between the developer's own two wallets), the replay of that match errors out, the "market meta" is a single simulated CRE broadcast from the owner key that hasn't updated since (while live 24h numbers beside it drift), practice sends zero transactions, Envio isn't deployed at all, Privy has no transaction, and the "Many Keys" proof is a throwaway passkey hitting a precompile. The engineering underneath is real and the onboarding is impressive, but the submission's claims run well ahead of what is live, and the docs contradict each other on what's fork-only vs testnet.

## 6. What would raise the score most

1. **Fix the match #1 replay** (or play and settle 3–5 fresh staked AUSD matches between distinct wallets) so ▶ REPLAY shows "✓ Verified against N on-chain checkpoints"; cite those txs.
2. **Make the meta live:** run the Pyth keeper (keeper.epoch is 0) and/or repeated CRE broadcasts so `currentEpoch` tracks real time; label snapshot age in the UI ("meta from 2 h ago") and drop or explain the conflicting live 24h % next to it.
3. **Deploy Envio** (hosted HyperIndex), set `VITE_INDEXER_URL` on Vercel, and show the "Live on Monad" panel — otherwise drop the Envio claim.
4. **Let a free player see a Monad tx:** e.g., a free practice "on-chain mode" that logs plays from the session key (gas is dripped anyway) with the sent→exec→final pill on each card.
5. **Privy:** add one real email sign-in + a session-signer `play` tx hash to PORTAL-COPY; fix the stale "turns on once…" sentence.
6. **Mera Many Keys:** make the claim match the UI — show the locker (encrypt a deck, reopen it) or bind the account passkey via `PasskeyRegistry` with a real tx.
7. **Reconcile docs:** README/MONAD-NATIVE still say 7702 is fork-only; SUBMISSION has Track 02 note, Kimi bounty, "awaiting the go"; README "four/fifth" contracts vs 8 deployed.
8. **UI cleanup:** show the BUFFED/NERFED meta on the phone landing; show AUSD in the header; hide the 11 un-mintable stocks (and $GOOGL from the shop); fix the practice end-screen contradiction; show full block numbers in the heartbeat; use a dedicated RPC to stop 429s.

---

## Fixed after round 1 (20:05–20:35 IST)

| Finding | Fix | Commit |
|---|---|---|
| The replay of match #1 fails ("no replay record") | Root cause: replay records lived only in `ladder_pairings`, which has a 1-hour TTL, so every match became un-replayable after an hour. A permanent `match_replays` row is now written when seat 0 opens the match. Match #1's record had already expired and can't be recovered | `b58a962` |
| Claims ahead of what's live (CRE "every epoch", "any match can be replayed", 300 ms per card, Kimi/Envio as claimed bounties, 7702 "fork only", Track 02 note, "four/fifth contract") | PORTAL-COPY, README and SUBMISSION now say what ran where:<br>- CRE = one `simulate --broadcast` write;<br>- per-card timings are the browser-measured 0.9–1.4 s / 1.5–1.9 s;<br>- Envio and Kimi are not claimed;<br>- the 7702 tx is cited on testnet;<br>- the Many Keys claim points at the Deck-screen locker (passkey accounts) | `584054c` |
| Stale meta beside live 24h % | Boards say "meta from N h ago"; Cards rows say "▼ x% meta", not "today" | `29d30d0` |
| 11 stocks "No live price" rows; un-buyable shop offers | Folded into one line on Cards ("N fighters without a live price right now can't be minted"); the shop hides offers it can't sell | `29d30d0` |
| Practice end screen says "settled by final-state signature" | Shown only for escrowed matches | `29d30d0` |
| Meta invisible on a phone | A one-line market-meta strip opens the landing and Arena below 900 px | `2c6f4fa` |
| Developer text in the Empire Monad panel | One line per item; precompile addresses and stake figures moved behind Details | `2c6f4fa` |
| Heartbeat block numbers look fake (4 digits) | The header shows the real head block ("block 70,712,369"); the chips show "…2369" | `d171083` |

Not fixed, because each needs MON, keys or the user:
- organic matches between distinct players;
- a deployed CRE DON workflow or a live meta keeper;
- Envio Cloud hosting;
- a Privy email sign-in transaction (dashboard origins);
- $MON card art (no Higgsfield credits);
- a free on-chain practice mode (a new feature, after the freeze).

---

## Round 2 verdict (fresh judge, ~20:50 IST): scores

| | Round 1 | Round 2 |
|---|---|---|
| Product quality | 6 | **7** |
| Technical excellence | 7 | 7 |
| Monad integration | 7 | 7 |
| Track fit | 5 | 5 |
| Innovation | 6 | 6 |
| CRE (req/tech/monad/innov) | 4/6/5/6 | **5/7/6/7** |
| Mera Best UX | 5/6/5/5 | **6/7/6/5** |
| Mera Many Keys | 3/5/7/5 | **5/7/6/6** |
| Privy | 3/5/4/4 | 2/5/3/4 |
| Envio | 2/5/3/3 | not claimed |

Round 2's remaining findings, in short:
- the ▶ Replay link for match #1 is a dead end;
- a practice win says "POT SECURED";
- the tutorial returns on every reload;
- the typed player name is ignored;
- mint buttons show on coins the Pyth plan doesn't cover;
- "Kimi · not configured" is dead UI;
- there is no $MON art;
- the meta is a single snapshot;
- one testnet match;
- Privy has no transaction;
- the social layer is empty.

## Round 3 (fresh judge, ~21:00 IST, after the round-2 fixes)

| | R1 | R2 | R3 |
|---|---|---|---|
| Product quality | 6 | 7 | 6 |
| Technical excellence | 7 | 7 | 7 |
| Monad integration | 7 | 7 | 7 |
| Track fit | 5 | 5 | 4 |
| Innovation | 6 | 6 | 6 |
| CRE | 4/6/5/6 | 5/7/6/7 | 5/6/6/6 |
| Mera Best UX | 5/6/5/5 | 6/7/6/5 | 5/7/6/5 |
| Mera Many Keys | 3/5/7/5 | 5/7/6/6 | 5/6/7/6 |
| Privy | 3/5/4/4 | 2/5/3/4 | 2/4/3/4 |

The scores move by a point either way from one judge to the next. The consistent message across three judges:
- the engineering is real and verified;
- the testnet proof is thin (one staked match, one CRE write, a frozen meta);
- Track 03's social layer is empty;
- Privy has no transaction.

Round 3's sharpest find was a **wrong citation**: `0xa89f…a492` is the first claim; the pot was paid by the second, [`0x8911e19b…7919`](https://testnet.monadvision.com/tx/0x8911e19bb5dad725d3681b94d919fcf290b4ba5c03e23669c829220baadf7919) (it emits `MatchSettled` and moves 0.018 / 0.002 MON). It is fixed everywhere, with:
- "in the block both results land" → "when the second result lands";
- the onboarding time → "about ten seconds";
- the replay-link probe now uses `/api/replay/:id/exists`, so no 404 is logged on every load.

Still open, and each needs MON, keys or the user:
- organic staked matches;
- a deployed CRE DON workflow or a running meta keeper;
- a Privy transaction (dashboard origins + sponsorship);
- Envio hosting;
- $MON art.
