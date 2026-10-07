# ROADMAP-WIN: a judge's five minutes with Mempire

Written 7 Oct after using the local fork build cold, as a judge would: no context, a laptop, five minutes. Every screen was captured in `docs/screens/`. Judging weights are 20% each for product, technical, Monad integration, track fit and innovation; bounties weigh their stated requirement at 40%.

## The 10 weaknesses that cost the most, ranked

1. **Monad's advantage is asserted, not shown.**
   - The only speed signal is the in-match badge ("LOGGED · 25 · 0.0S"). On the local fork that reads **0.0 s**, which a judge will take as fake.
   - Nowhere does the app show what makes Monad different: blocks moving through Proposed → Voted → Finalized in ~300/600 ms.
   - A judge leaves thinking "an EVM game", not "a Monad game".
   - *Monad integration: high cost.*
2. **The copy is wrong about the chain.**
   - README, SUBMISSION, the demo script and code comments say "400 ms blocks". Monad has made 300 ms blocks since v0.15.0, with finality in 2 slots (~600 ms).
   - Judges from the Monad team will notice.
3. **There is no memorable "wow".**
   - The best technical fact (every card drop is a transaction, and the match is checkpointed by state hash) is invisible after the match ends.
   - Nothing lets a judge *watch a match again from the chain* and see it verified.
4. **A player's moves don't visibly land on chain during play.**
   - The badge counts plays, but a unit dropped on the board shows nothing about its transaction.
   - The game-feel moment ("I dropped a card and it went on chain while the unit walked") is lost.
5. **First match, first minute: no guidance inside the match.**
   - The intro tour explains stakes and practice, but a new player in Practice is dropped onto a 3D board with no prompt about dragging, elixir, lanes or towers. Judges who can't win a practice match in 60 seconds won't play the staked one.
6. **Competition is under-sold.**
   - Empire has one leaderboard (net winnings).
   - The trophy ladder and the clan rankings exist on the relay (`/api/ladder`, `/api/clans-top`) but are not shown together, so the social/culture track fit (T3) is weaker than it is.
7. **Explorer links on the local fork go nowhere.**
   - MonadVision links for fork hashes are dead links. The honest rule is plain text on the fork and links on testnet.
8. **Bounty evidence is mostly in docs.**
   - CRE vs Pyth meta, Envio and Mera are visible, but the network-level Monad features (staking epoch, reserve balance, P256) don't appear in the UI at all.
9. **The economy is opaque at first glance.**
   - Merge, chests and $MEMPIRE are reachable but unexplained. Merge needs 100 $MEMPIRE, which a new player doesn't have.
10. **Dead time in staked flows.**
    - The faucet cooldown ("AUSD on its way") and first-match escrow are honest now, but there's no "what's happening on chain" visual while waiting.

## Plan: top 5 by impact × effort (none needs MON or user keys)

| # | Feature | Fixes | Impact | Effort |
|---|---|---|---|---|
| 1 | **Monad pipeline: live commit-state strip + honest two-timer receipts** | 1, 2, 7, 10 | very high | M |
| 2 | **Moves that land: on-chain state on each deployed unit** | 4 | high | S–M |
| 3 | **Verifiable replay from the chain** | 3 | very high (the wow) | L |
| 4 | **Coached first match (tutorial)** | 5 | high | M |
| 5 | **Leaderboards & clans: ladder, net $, top clans in one place** | 6 | medium | S |

### Acceptance criteria

1. **Monad pipeline.**
   - A strip in the Arena and the battle HUD subscribes to `monadNewHeads` on Monad testnet's public WebSocket (a read-only live read) and shows each new block as a chip moving Proposed → Voted → Finalized with the **measured** ms.
   - It is labelled "network heartbeat · Monad testnet" so it never claims to be the fork.
   - If the WebSocket is unavailable it says so. Nothing is simulated.
   - Play receipts report two timers, "executed X ms" and "final Y ms". On the fork they are labelled "local fork · instant mining", and testnet timings appear only on 10143.
   - The pending state comes from `txpool_statusByHash` on testnet only.
   - Every "400 ms" in copy, docs and comments is corrected to 300 ms / ~600 ms finality.
   - Unit tests cover the commit-state reducer (out-of-order messages, skipped Voted, competing `blockId`s dropped on finalize).
2. **Moves that land.**
   - Each unit spawned from *your* card shows a small chip above it: grey "sent" → green "on chain" (receipt) → finalized (testnet) or "fork" (local), plus the tx hash on hover.
   - It is driven by the play log's real receipts, never by a timer. It is tested in the browser pass.
3. **Verifiable replay.**
   - The relay records each staked match's seed, format and input delay against its on-chain match id. Its `GET /api/replay/:matchId` returns those fields; everything else comes from the chain.
   - The app's Replay screen rebuilds the match from chain data only: decks from `MatchCreated`/`MatchJoined` card ids, plays from `Played` events, the meta epoch from the match.
   - It re-runs the deterministic sim, plays it back in the 3D arena (pause, 1×, 4×), and **checks each recomputed state hash against the on-chain `Checkpoint` events**, showing "verified against N on-chain checkpoints" or the first tick where they diverge.
   - It is reachable from Empire's battle history and the settlement feed.
   - Tests: a relay test for the seed record and a sim test that a replay of a recorded match reproduces its checkpoints.
4. **Coached first match.**
   - "Learn for free" and first-ever Practice start a coached match: step prompts anchored to the real UI (drag a card onto your half, watch elixir, take a tower, use the lanes) that advance on the player's actual actions, plus a skip control.
   - It runs once per device. "Replay tutorial" in the account menu restarts it.
   - Browser test: a fresh profile completes the coached steps.
5. **Leaderboards & clans.**
   - Empire gets a tabbed board: Trophies (`/api/ladder`), Net $ (AUSD) and Net MON (chain-verified), and Top clans (`/api/clans-top`).
   - Your own row is highlighted. Empty states are honest.
   - Browser test: the tabs load with real data after a staked match and a clan exist.

## Monad-native coverage

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Live commit-state strip (`monadNewHeads`/`monadLogs`) | **live-read**, built: `app/src/lib/monadHeads.ts`, `components/MonadPipeline.tsx`. Measured in Chrome: voted ~290 ms, final ~575 ms | W1 |
| 2 | Two-timer receipts (`eth_sendRawTransactionSync` + finalized) | **built** (`chain/landing.ts`, `state/playLog.ts`). Fork shows "local fork · N ms" (instant mining); executed + final timings **awaiting testnet go** | W1 |
| 3 | Tx status (`txpool_statusByHash`) | **built** (`chain/landing.ts`), active on Monad networks only; **awaiting testnet go** | W1 |
| 4 | Passkeys on chain (Mera + P256 `0x0100`) | Mera **built**; P256 binding contract **built** + tested on the fork (`0x0100` works on anvil) | after the top 5 |
| 5 | Native staking reads (`0x1000`) | **live-read**: epoch, proposer and validator panel from testnet | after the top 5 |
| 6 | Gas correctness (limit-charged, reserve 10 MON, 128 KB, MIP-8) | **built**: estimate ×1.15 tight limits, simulate-before-send, reserve-aware relayer drips, MIP-8 layout notes | after the top 5 |
| 7 | x402 / MPP payments | **not applicable**: Mempire's money is the staked pot, escrowed by the arena in MON or AUSD (EIP-2612 permit). There is no API or content sold per call, and routing stakes through a facilitator would add a custodian. | — |
| 8 | Canonical contracts (WMON, Multicall3, Permit2, Sourcify) | Multicall3 **built** for batched reads; Sourcify verification **in the deploy script**; WMON **not applicable** (stakes are native MON or AUSD; wrapping adds a step and no capability); Permit2 **not applicable** (AUSD has native EIP-2612) | after the top 5 |

(Statuses are updated as each lands; see the commit for each.)

## Next 5 after this wave

1. Spectator mode: watch a live staked match through `monadLogs` on the arena.
2. Gasless onboarding through EIP-7702 + a 4337 paymaster (needs testnet).
3. A clan war format: clan-vs-clan staked brackets.
4. A season pass from `$MEMPIRE` sinks.
5. Damage numbers and a tower-fall slow-mo for the trailer.

## Shipped in this wave

- **W1** Monad pipeline (live testnet commit states, two-timer receipts, 300 ms copy): `d2bf6a4`
- **W2** Moves that land (HUD ticker driven by real receipts): `338d42c`
- **W3** Verifiable replay from the chain: see the commit after `338d42c`

