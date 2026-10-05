# Mempire on Monad

**A real-time 1v1 card battler where the market is the meta.** Every fighter is a real asset — majors, memecoins and tokenised stocks. Today's price moves buff or nerf each one a little. Two players put up a dollar stake, play a three-minute lane battle, and a contract on Monad pays the winner, in the same block both results land.

Sign in with a passkey: no seed phrase, no extension, no wallet popups during a match.

- **Play:** `TODO: Vercel URL` (Monad testnet)
- **Track:** 02 · Consumer Products & Payments
- **Demo video:** `TODO`

> Built for Monad Metropolis (Sep 1 – Oct 13 2026). Ported from the Solana version of Mempire, see [Attribution](#attribution-and-pre-existing-work).

---

## What a first-time player does

1. **Opens the link and taps _Play now_.** One passkey prompt (Face ID, fingerprint or device PIN) creates the account. Mera derives a secp256k1 key from the authenticator's PRF output. No seed phrase exists, nothing secret is stored, and the same passkey brings the same account back on any device.
2. **Gets a deck without asking.** On first sign-in the relay mints an **8-fighter starter deck** (eight ERC-721s) to the account, requests **10,000 test AUSD** from Agora's faucet, and drips a little MON for gas. The player watches it land, in about a second.
3. **Picks a stake: $1 AUSD on the Pauper tier.** AUSD is pulled with an EIP-2612 permit inside the stake transaction, so it is one transaction, not approve-then-stake. The same transaction locks the deck and funds a **per-match session key**.
4. **Plays.** Every card drop is a Monad transaction from the session key: no popup, logged on chain while the match is played. The badge shows how long each one took to land, measured send-to-receipt.
5. **Gets paid.** Each seat's session key records the winner its own simulation computed. The second claim settles the match in the same transaction: **90% to the winner, 10% rake**, plus a chest and 50 $MEMPIRE for the first sixteen wins.

No step needs a wallet extension, a faucet visit or a seed phrase.

---

## Why Monad

| | |
|---|---|
| **400 ms blocks** | A card play is in a block before the unit crosses the bridge. The play log isn't summarised after the match; it is written while the match is played. |
| **Cheap enough to log every action** | About 32k gas per play. Sending each card play as its own transaction is only viable because blocks are fast and gas is cheap. |
| **Settlement in one block** | The second claim pays the pot in the same transaction. |
| **EVM** | Cards are ERC-721s that show up in any wallet or explorer. AUSD is a standard ERC-20 with permit. |

---

## Architecture

```
            passkey (Mera PRF) ──► account key ──► viem
                                                    │
 ┌──────────── browser ──────────────┐              ▼
 │ React + three.js arena            │   ┌──────── Monad testnet ────────┐
 │ deterministic lockstep sim (i32)  │──►│ MempireArena  escrow · play log│
 │ session key per match ────────────┼──►│               two-claim settle │
 └────────┬──────────────────────────┘   │ MempireCards  ERC-721 · merge  │
          │ ws (lockstep relay)          │               chests · Pyth    │
 ┌────────▼──────────┐                   │ MarketMeta    CRE receiver     │
 │ relay (Railway)   │── relayer key ───►│ MempireToken  $MEMPIRE         │
 │ matchmaker, hash  │                   └───────▲───────────────▲────────┘
 │ referee, onboard, │                           │               │
 │ Pyth proxy, NFT   │          Chainlink CRE workflow     Envio HyperIndex
 │ metadata, locker  │          (24h moves → ±15% meta)    (leaderboard, feed)
 └───────────────────┘
```

### Contracts (`contracts/`, Foundry, Solidity 0.8.28)

| Contract | What it does |
|---|---|
| `MempireCards` | Every fighter is an ERC-721. **Mint** for 0.01 MON or 250 $MEMPIRE, with a fresh **Pyth** price posted in the same transaction (no live price, no mint); the card records the price it was minted at. **Merge** a duplicate for a level (100 × level $MEMPIRE, capped at 10). **Chests** are granted by wins, unlocked on a timer and opened against a future block hash. **Starter decks** come from the relayer, once per address. The archetype is `keccak256(feedId) % 6`, fixed by the asset's identity. |
| `MempireArena` | Stakes in **MON or AUSD** on four fixed tiers enforced by the contract. Per-match **session keys** are funded from the stake transaction. **Play log**: `play(tick, card, x, y)` and `checkpoint(tick, hash)`. **Two-claim settlement**: agreement pays 90/10, disagreement voids and refunds, and after the deadline a lone claim stands (no claims at all refunds both). Cards are locked by reference to a live match, so settling is unlocking; no path can strand a card or a pot. |
| `MarketMeta` | A Chainlink CRE receiver. Each epoch it stores a bounded (±15%) hp and damage modifier per fighter. Matches snapshot the epoch at join. |
| `MempireToken` | $MEMPIRE: fixed supply, no mint after construction. Every use in the game is a sink. The only emission is the capped win reward. |

**Tests:** `cd contracts && forge test` runs **50 tests**, including a fuzz test that settlement conserves value across every tier and claim combination.

### Deployed addresses (Monad testnet, chain 10143)

`TODO after deploy`. Also in [`shared/deployments/10143.json`](shared/deployments/10143.json). All contracts are verified on Sourcify (MonadVision).

| | Address |
|---|---|
| MempireArena | `TODO` |
| MempireCards | `TODO` |
| MarketMeta | `TODO` |
| MempireToken | `TODO` |

External: Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43`, AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, CRE simulation forwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192`.

### The market is the meta

A Chainlink **CRE** workflow (`cre/market-meta`) runs on a cron schedule:

1. Reads each fighter's 24-hour move (CoinGecko for crypto and memecoins; Pyth Hermes for stocks when a key is set).
2. Takes a per-coin **median across the DON**.
3. Maps it to `bps = clamp(round(change% × 40), ±1500)`, so a +20% day gives +8% hp and damage.
4. Writes one report to `MarketMeta`.

The matchmaker sends both seats the same epoch, and the deterministic simulation applies the modifiers in integer maths and hashes them with the state. Two clients therefore can't disagree about how strong a fighter is today. The modifier never touches elixir cost and is smaller than what levels give, so the market reshuffles the meta without becoming a way to buy wins.

### Client (`app/`)

React 19 + three.js (React Three Fiber) + Zustand + viem. The simulation (`app/src/sim`) is deterministic fixed-point lockstep at 20 ticks a second, with a state hash every 2 seconds; a mismatch voids the match.

**Accounts.** Three kinds of signer:
- **Mera passkey**: the default.
- **Guest**: a key held in the browser, for authenticators without PRF.
- **EIP-6963 browser wallets**.

**Passkey sessions** sign without prompts. They expire after 30 idle minutes or 2 hours, with a visible countdown. Stakes from the Duke tier up ask for the passkey again, and that re-derives the account rather than trusting the open session.

**Passkey locker.** A second PRF namespace (`mempire.locker.v1`) derives, through HKDF, an AES-256-GCM key and an unlinkable storage id. Decks and scouting notes are encrypted in the browser, and the relay stores ciphertext under an id it cannot tie to the account. The same passkey on another device opens it.

### Relay (`server/`)

Express + `ws`:
- matchmaker, lockstep relay and hash referee;
- signed-request auth (EIP-191);
- `/api/onboard` (starter deck, AUSD, gas drip from a relayer key that is never the owner key);
- a Pyth Hermes proxy, since Hermes now needs an API key and the key stays server-side;
- ERC-721 metadata;
- chain-verified leaderboard;
- clans;
- the encrypted locker store.

### Indexer (`indexer/`)

Envio **HyperIndex V3** on Monad testnet. It indexes every event into:
- per-player records and net MON and AUSD;
- per-fighter win rates, split by whether the market had buffed or nerfed the fighter that day;
- a live play feed resolved to fighter and level;
- chests, market epochs and daily aggregates.

The **Live on Monad** panel in the app reads it.

---

## Run it locally

```bash
git clone --recurse-submodules https://github.com/nickthelegend/mempire-monad && cd mempire-monad
# contracts
cd contracts && forge test && cd ..
# local chain with mock Pyth + AUSD (port 8611)
anvil --port 8611 --prune-history 300 &
# app against the local chain
cd app && npm install && VITE_CHAIN_ID=31337 npm run dev
# relay
cd server && npm install && cp .env.example .env && npm run dev
```

Simulation harness: `cd app && npx tsx scripts/sim-test.ts`.

---

## Sponsor integrations

| Sponsor | How it is used | Where |
|---|---|---|
| **Monad Foundation: Mera** | The entire account layer: one passkey ceremony creates the account. Prompt-free signing sessions with idle and hard expiry and a visible countdown; step-up re-confirmation for big stakes; the stateless test passes (clear storage, sign in, same account). | `app/src/lib/passkey.ts`, `app/src/state/wallet.ts` |
| **Mera: One Passkey, Many Keys** | `mempire.locker.v1` does non-account work: HKDF derives an AES-GCM key and an unlinkable storage id for an end-to-end encrypted locker that opens on any device with the same passkey. | `app/src/lib/locker.ts` |
| **Agora AUSD** | The stake currency: dollar pots, pulled by EIP-2612 permit inside the stake transaction. New accounts get test AUSD from Agora's testnet faucet on first sign-in. | `MempireArena.sol`, `app/src/chain/actions.ts` |
| **Chainlink CRE** | Orchestration layer for the market meta: cron → HTTP with DON consensus (median per coin) → `writeReport` → `MarketMeta.onReport` (a correct `IReceiver`, forwarder-gated, stale epochs rejected). | `cre/`, `contracts/src/MarketMeta.sol` |
| **Pyth** | The eligibility gate: a card can only be minted with a fresh Pyth price posted in the same transaction, and it records the price it was minted at. | `MempireCards.mint`, `server` Pyth proxy |
| **Envio** | HyperIndex V3 with derived and aggregated entities powering the leaderboard, the live play feed and fighter win rates. | `indexer/`, `app/src/components/LiveOnMonad.tsx` |

---

## Attribution and pre-existing work

- **Pre-existing (ours):** the game client, art, audio, the deterministic simulation, and the relay's matchmaker and clans were built for the Solana version of Mempire ([github.com/nickthelegend/mempire](https://github.com/nickthelegend/mempire)) in Jul–Aug 2026. The first commit in this repository imports them unchanged so the port is visible in the history. Everything chain-related was rewritten for Monad during Metropolis: the contracts, the accounts, the stakes and escrow, the play log, the market meta, the indexer, and onboarding.
- **External code:** OpenZeppelin Contracts v5.4 (MIT), forge-std (MIT/Apache-2.0), viem (MIT), `@category-labs/mera` (MIT/Apache-2.0), `@scure/bip32` and `@scure/bip39` (MIT), the Chainlink CRE SDK, the Envio HyperIndex CLI, three.js and React Three Fiber (MIT). Character models are KayKit (CC0). `IReceiver.sol` is copied from Chainlink's CRE consumer-contract guide.
- **AI tools:** this port was written with Claude Code (Anthropic), which wrote most of the code, tests and documentation under the author's direction. Card art and audio were generated earlier with Higgsfield.

## License

MIT. See [LICENSE](LICENSE).
