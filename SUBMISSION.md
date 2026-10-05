# Mempire — Monad Metropolis submission

| | |
|---|---|
| **Project** | Mempire: a real-time 1v1 card battler where the market is the meta |
| **Track** | **03 · Social, Attention & Culture** (recommended; currently registered as 02, see below) |
| **Network** | Monad testnet (10143) — *not deployed yet; everything runs on a local anvil chain (`scripts/local-up.sh`) until the team says deploy* |
| **Live app** | `TODO: Vercel URL` |
| **Repo** | https://github.com/nickthelegend/mempire-monad (MIT) |
| **Demo video (≤ 3 min)** | `TODO` |
| **Pitch video (≤ 2 min)** | `TODO` |
| **Judge login** | None needed. Open the link, tap **Play now**, then **Create with passkey** (or **Play as Guest** on a browser without passkey PRF). |

## One paragraph

Mempire turns the market into a game. Every fighter is a real asset: BTC, MON, NVDA, BONK and 32 more. A Chainlink CRE workflow writes today's price moves on chain as small, bounded buffs and nerfs. Two players put a dollar of AUSD on a three-minute lane battle, every card they drop is a Monad transaction from a per-match session key, and the contract pays the winner in the block where both results land. A new player gets there with one passkey prompt: no seed phrase, no extension, no faucet, no popups during the match.

## Why this is a consumer payments product

Most of a consumer crypto product is the first five minutes, so that is where most of the work went:

- **Zero to account in one prompt.** Mera passkeys: the account is derived from the authenticator. It works the same on the next device, and nothing secret is ever stored.
- **Zero to funded in zero taps.** On first sign-in the relay mints the starter deck (8 ERC-721s), gets 10,000 test AUSD from Agora's faucet, and drips gas, without being asked.
- **Dollar stakes, one transaction.** AUSD is pulled with an EIP-2612 permit inside the stake transaction. The pot is quoted in dollars.
- **Payment and settlement are the same transaction.** The second seat's result claim pays 90% to the winner and 10% rake, atomically. Disagreement refunds both. Abandonment can't lock a pot.
- **No popups while playing.** A per-match session key is funded in the stake transaction. It can log plays and claim for its own seat and nothing else, and its unspent gas is swept back to the player afterwards.

## Track: recommend moving to **03 · Social, Attention & Culture**

Polaris, from the same team, is in Track 2 and is the stronger fit for Agora's T2-only cross-border bounty. Two entries from one team in one track would compete for the same three places. Mempire's real strength is cultural:
- every ticker is a fighter with a community behind it;
- the market's mood buffs and nerfs it daily;
- clans, a ladder, a live play feed and shareable cards.

Every bounty Mempire targets is open to all tracks, so moving costs nothing. T3 also opens Tencent Hunyuan (credits), which the OpenAI-compatible AI layer could add as a commentary provider. If it stays in T2, the consumer-payments framing below still holds.

## Bounties targeted (status: built and tested on a local chain; keys are listed in `docs/SPONSOR-GAP.md`)

| Bounty | Track | How Mempire meets the stated requirement |
|---|---|---|
| **Privy: beyond login** | All | Email sign-in creates a Privy **embedded wallet**. Its own transactions are **gas-sponsored** (`sponsor: true`). A **session signer** (`addSigners`) bound by a **policy** (default deny; only arena `play`/`checkpoint`/`claim`, value 0, this chain) sends in-match calls as the player, so there are no popups and no path to funds. 29 end-to-end checks. |
| **Monad Foundation: Mera UX** | All | Mera is the account layer, with one passkey ceremony and nothing secret stored. Signing is prompt-free. Sessions have idle and hard expiry, a visible countdown, a lock option, and step-up for big stakes. The stateless test passes. The starter deck lands about 1–3 s after sign-up. |
| **Mera: Many Keys** | All | The `mempire.locker.v1` PRF namespace feeds HKDF, which yields an AES-256-GCM key and an unlinkable storage id. That powers an end-to-end encrypted deck and notes locker that opens on any device with the passkey. |
| **Chainlink CRE** | All | A cron, HTTP-consensus, `writeReport` workflow into the `MarketMeta` receiver sets each fighter's daily ±15% modifier, which the deterministic sim applies. 33 tests, compiled to WASM. Simulation needs `cre login`. |
| **Envio** | All | HyperIndex V3 with derived entities (records, net per currency, per-fighter win rates on buffed and nerfed days, the play feed, epochs with source). It runs on the local chain, and verify-local checks indexed rows against the chain (52/52). The app's **Live on Monad** panel reads it. |
| **Kimi** | All | Kimi is the AI opponent's strategist, using tool calling (`deploy_card`, `wait`, `get_market_meta`). Its moves are validated and played through the human input path, and it provides the caster lines. 58 checks against the mock and a fake Moonshot server. |
| **Monad Foundation: Community Team** | All | Only if the team was onboarded through a Metropolis community supporter. |

**Also integrated** (not a separate cash bounty):
- **Pyth:** a fresh update is pushed in the same transaction for minting and for **price-driven stats**. `MarketMeta.postFromPyth` derives modifiers from spot vs EMA on chain.
- **Agora AUSD:** the stake currency, pulled with an EIP-2612 permit.

**Not claimed:**
- Agora: a mobile trading app (T1) or cross-border remittance (T2), neither of which fits.
- Dynamic: Privy and Mera already cover the account layer.
- Kuru, Perpl, MetaMask: T1 and trading.
- Alchemy: only a URL swap here.
- Nansen: no real use for its data in a game.

## Monad integration

- Every card play is an on-chain transaction from a session key, viable only because of 400 ms blocks and low gas. The in-match badge shows measured send-to-receipt latency.
- The second claim settles the pot in the same block.
- Gas limits are sized from estimates (Monad bills the limit), and the session key's float is swept back after the match.
- Contracts are verified on Sourcify through MonadVision.

## Demo script (≤ 3 min)

1. **0:00 — The hook.** "Every coin is a fighter, and today's market decides who's strong." Show the Cards screen with live prices and ▲▼ meta badges.
2. **0:15 — First five minutes.** Fresh browser, tap **Play now**, then **Create with passkey**, then Face ID. The account exists. The starter kit card says *Minting your starter deck on Monad*, then *Your deck is on chain · 1.2s*. Open Empire: 8 cards, 10,000 AUSD, MON for gas. No seed phrase, extension or faucet.
3. **0:45 — Stake a dollar.** Arena, **$ AUSD**, Pauper ($1), Battle. A second device (or a second judge) queues and they are matched. One transaction each: the permit and the stake together.
4. **1:00 — Play.** Drop cards. The badge reads *on Monad · 7 · 0.6s*, with each play a transaction. Click it to open the latest play on MonadVision.
5. **1:45 — Win.** The result screen shows the pot settled and paid ($1.80 to the winner), a chest granted on chain, and 50 $MEMPIRE. Open the chest: it commits to the next block, reveals, and mints real ERC-721 cards.
6. **2:10 — The meta.** Card detail shows *NVDA +8% hp & dmg today*, sourced from Chainlink CRE into MarketMeta. Show the CRE simulate output and the `MetaPosted` transaction.
7. **2:30 — Stateless.** Clear site data, then **I already have a Mera passkey**: same address, same cards. Open the passkey locker on the Deck screen to restore saved decks from an id the server can't link.
8. **2:45 — Live on Monad.** The Envio-indexed play feed, leaderboard, and win rates on buffed days.

## Verifiable evidence

- **Contracts:** `forge test` gives 50/50, including the settlement-conservation fuzz test.
- **Simulation:** `npx tsx app/scripts/sim-test.ts` is deterministic with and without the market meta. The client and contract archetype derivations match for all 36 fighters.
- **CRE:** `bun test` gives 33/33.
- **Indexer:** `pnpm test` gives 6/6.
- **Every suite at once:** `./scripts/local-up.sh --relay && ./scripts/test-all.sh` runs 13 suites, all green. They include `test-e2e.mjs`, which walks the whole game on the local chain in 22 checks, `test-privy.mjs` (29) and `test-ai.mjs` (58).
- **Testnet:** `TODO` once deployment is allowed (addresses, a settled match id, the CRE report transaction).
