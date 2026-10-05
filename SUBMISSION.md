# Mempire — Monad Metropolis submission

| | |
|---|---|
| **Project** | Mempire: a real-time 1v1 card battler where the market is the meta |
| **Track** | **02 · Consumer Products & Payments** |
| **Network** | Monad testnet (10143) |
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

## Bounties claimed

| Bounty | Track | What qualifies it |
|---|---|---|
| **Monad Foundation: Best Mera-Powered UX** | All | Mera is the whole account layer, with one passkey ceremony and no email or OTP. **Time to first transaction:** the starter deck lands about a second after sign-in. **Session design:** prompt-free signing for play, a 30-minute idle / 2-hour hard expiry with a countdown on the account chip, a locked state that reopens with one prompt, and step-up re-derivation for stakes from the Duke tier up. **Stateless test:** clear storage or switch device, sign in with the same passkey, and the same address comes back. Real testnet transactions throughout. |
| **Mera: One Passkey, Many Keys** | All | PRF namespace `mempire.locker.v1` does non-account work: HKDF splits it into a non-extractable AES-256-GCM key and a 256-bit storage id. Decks and scouting notes are encrypted in the browser and stored under an id the relay cannot link to the account. Salts are namespaced, nothing derived is persisted, and the locker opens on a second device with the same passkey. |
| **Chainlink: Best workflow with CRE** | All | `cre/market-meta` is the orchestration layer for the game's balance: cron trigger, then HTTP with DON consensus (a median per coin), then a `(uint64,uint16[],int16[])` report written by `writeReport` to `MarketMeta.onReport`. That contract is an `IReceiver`, gated to the forwarder, and rejects stale epochs. Matches snapshot the epoch on chain and the simulation applies it, so the workflow decides real game outcomes. Simulated with `cre workflow simulate --broadcast` against the testnet MockKeystoneForwarder (tx: `TODO`). 33 tests. |
| **Envio: Best use of Envio** | All | HyperIndex V3 on Monad testnet, with a non-trivial schema and derived entities: player records, net MON and AUSD, per-fighter win rates split by buffed and nerfed days, a play feed resolved to fighter and level, chests, epochs and daily stats. It powers the **Live on Monad** panel. 6 handler tests. |
| **Monad Foundation: Best Community Team Project** | All | `TODO: only if the team was onboarded through a Metropolis community supporter. Set it in the portal profile.` |

**Considered but not claimed:**
- **Privy** and **Dynamic**: Mera is the account layer, and a second account SDK would muddle it.
- **Agora Cross-Border Payments**: requires a mobile remittance app.
- **Kuru**, **Perpl** and **MetaMask**: T1 only, or trading-specific.
- **Alchemy**: the app accepts any RPC, but nothing Alchemy-specific is load-bearing, so claiming it would be a URL swap.

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
- **Testnet:** `TODO` (addresses, a settled match id, the CRE report transaction).
