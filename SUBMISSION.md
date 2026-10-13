# Mempire — Monad Metropolis submission

| | |
|---|---|
| **Project** | Mempire: a real-time 1v1 card battler where the market is the meta |
| **Track** | **03 · Social, Attention & Culture** |
| **Network** | **Monad testnet (10143)**, deployed 12 Oct; 8 contracts verified on Sourcify (addresses in the README). It also runs locally on a fork of testnet with one command (`scripts/local-up.sh`). |
| **Live app** | https://mempire-monad.vercel.app (relay: https://relay-production-9c75.up.railway.app) |
| **Repo** | https://github.com/nickthelegend/mempire-monad (MIT) |
| **Judge login** | None needed. Open the link, tap **Play now**, then **Create with passkey** (or **Play as Guest** on a browser without passkey PRF). |

## One paragraph

Mempire turns the market into a game. Every fighter is a real asset: BTC, MON, NVDA, BONK and 32 more. A Chainlink CRE workflow writes today's price moves on chain as small, bounded buffs and nerfs. Two players put a dollar of AUSD on a three-minute lane battle, every card they drop is a Monad transaction from a per-match session key, and the contract pays the winner when the second result lands. A new player gets there with one passkey prompt: no seed phrase, no extension, no faucet, no popups during the match. Afterwards, anyone can replay the match from Monad and see it verified against the state hashes both players posted, and the app shows Monad's own block pipeline, live, as it plays.

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

## Portal fields (copy-paste)

| Field | Value |
|---|---|
| Project name | Mempire |
| Tagline | A 1v1 card battler where the market is the meta: every fighter is a real asset, and today's price moves buff or nerf it. |
| Track | 03 · Social, Attention & Culture (or 02 if the team keeps it there) |
| Bounties | Chainlink CRE · Mera (Best UX) · Mera (Many Keys) · Privy (see `docs/PORTAL-COPY.md` for status) |
| Repo | https://github.com/nickthelegend/mempire-monad |
| Live URL | https://mempire-monad.vercel.app |
| Contract addresses | Arena `0xec897071929657b898C18513EF85EC8A8f898Ea3`, Cards `0xde510Aa056ab8fA5B867Ac9fEF90a9c6CB37dC22`, Token `0xFe140f43017CaA1f201f9e1DC7989c1F70f45234`; all 8 in `shared/deployments/10143.json` |
| Pre-existing work | Game client, art, audio, simulation, matchmaker and clans came from the Solana version (Jul–Aug 2026). All on-chain and sponsor work is new; see README → Attribution. |
| AI tools | Claude Code wrote most of the code, tests and docs under the author's direction. Higgsfield made the art earlier. No AI runs in the hosted app (Kimi is off). |

## Bounties targeted (status: built and tested on the local fork; the keys each one still needs are in `docs/SPONSOR-GAP.md`)

| Bounty | Track | How Mempire meets the stated requirement |
|---|---|---|
| **Privy: beyond login** | All | Email sign-in creates a Privy **embedded wallet**. Its own transactions are **gas-sponsored** (`sponsor: true`). A **session signer** (`addSigners`) bound by a **policy** (default deny; only arena `play`/`checkpoint`/`claim`, value 0, this chain) sends in-match calls as the player, so there are no popups and no path to funds. 21 checks on the policy and on honest 503s without keys. **The live path needs Privy keys** (not yet provided). |
| **Monad Foundation: Mera UX** | All | Mera is the account layer, with one passkey ceremony and nothing secret stored. Signing is prompt-free. Sessions have idle and hard expiry, a visible countdown, a lock option, and step-up for big stakes. The stateless test passes. The starter deck lands about 1–3 s after sign-up. |
| **Mera: Many Keys** | All | The `mempire.locker.v1` PRF namespace feeds HKDF, which yields an AES-256-GCM key and an unlinkable storage id. That powers an end-to-end encrypted deck and notes locker that opens on any device with the passkey. |
| **Chainlink CRE** | All | A cron, HTTP-consensus, `writeReport` workflow into the `MarketMeta` receiver sets each fighter's daily ±15% modifier, which the deterministic sim applies. 33 tests, compiled to WASM. **Simulation needs `cre login`.** Meanwhile the same `MarketMeta` takes Pyth momentum, which runs live locally. |
| **Envio** (built, not claimed: the hosted indexer needs an Envio Cloud repo connection) | All | HyperIndex V3 with derived entities (records, net per currency, per-fighter win rates on buffed and nerfed days, the play feed, epochs with source). It runs on the local chain, and verify-local checks indexed rows against the chain (52/52). The app's **Live on Monad** panel reads it. |
| **Kimi** (not claimed: off in the hosted app by the team's choice) | All | Kimi is the AI opponent's strategist, using tool calling (`deploy_card`, `wait`, `get_market_meta`). Its moves are validated and played through the human input path, and it provides the caster lines. 46 checks against a fake Moonshot server (a test double, used only in tests). **The live path needs `MOONSHOT_API_KEY`**; without it the app offers only the classic bot, labelled as such. |
| **Monad Foundation: Community Team** | All | Only if the team was onboarded through a Metropolis community supporter. |

**Also integrated** (not a separate cash bounty):
- **Pyth:** a fresh update is pushed in the same transaction for minting and for **price-driven stats**. `MarketMeta.postFromPyth` derives modifiers from spot vs EMA on chain. Locally, an IPyth-compatible `LocalPriceOracle` accepts only relay-signed updates built from live OKX/CoinGecko quotes.
- **Agora AUSD:** the stake currency, pulled with an EIP-2612 permit.

**Not claimed:**
- Agora: a mobile trading app (T1) or cross-border remittance (T2), neither of which fits.
- Dynamic: Privy and Mera already cover the account layer.
- Kuru, Perpl, MetaMask: T1 and trading.
- Alchemy: only a URL swap here.
- Nansen: no real use for its data in a game.

## Monad integration

Monad-native, with where each runs (details in [docs/MONAD-NATIVE.md](docs/MONAD-NATIVE.md)):

| Integration | Runs |
|---|---|
| Live block pipeline: `monadNewHeads` commit states with measured ms (~290 ms voted, ~575 ms final) | live testnet read |
| Per-play two-timer receipts: `eth_sendRawTransactionSync` + finality checked against the finalized hash; `txpool_statusByHash` | **testnet**: browser-measured, executed 0.9–1.4 s, final 1.5–1.9 s (match #1) |
| Verifiable replay: match re-run from on-chain plays and checked against on-chain state checkpoints | local fork (any chain) |
| Passkeys: Mera accounts + P256VERIFY `0x0100` (`PasskeyRegistry`, and the in-app check) | live testnet read; contract tested on Osaka |
| Native staking precompile `0x1000` via Multicall3 | live testnet read |
| Gas on Monad: explicit limits, simulate-before-send, 10 MON reserve-aware drips | built + unit-tested |
| Spectate a live staked match: `Played` logs via `monadLogs` drive the sim; checkpoints verified as they land | built; on testnet it reads `monadLogs`; no live match to watch at the time of judging |
| Gasless chests: EIP-7702 delegation + `MempirePaymaster` on the canonical EntryPoint v0.8; the relay bundles | **testnet**: open `0xb0cec249…cc59`, reveal `0x342a7b31…3c37`; player MON unchanged |
| x402 / MPP | not applicable: the money is an escrowed pot, not a per-call sale |

- Every card play is an on-chain transaction from a session key, viable only because of 300 ms blocks (final in ~600 ms) and low gas.
- The second claim settles the pot in its own transaction: 90% to the winner, 10% rake.
- Gas limits are sized from estimates (Monad bills the limit), and the session key's float is swept back after the match.
- Contracts are verified on Sourcify through MonadVision.

## Demo script (3:00)

| Time | Shot | Say |
|---|---|---|
| 0:00–0:15 | The first screen: "Every coin is a fighter", and under it Monad testnet's blocks turning voted → final, live, with ms | "That strip is Monad, live: a block is voted in ~290 ms and final in ~575 ms. Every card you play is one of those transactions." |
| 0:15–0:40 | **Play now → Create with passkey →** Face ID; the starter deck lands (*Your deck is on chain · 4s*) | "One passkey prompt. No seed phrase, no extension, no faucet." |
| 0:40–0:55 | First Practice: the coach ("Drop a fighter 1/4 → … → You've got it") | "A coached first match, driven by what you actually do." |
| 0:55–1:10 | Arena → $1 Ranked in two windows; they match; one transaction each (permit + stake) | "A dollar stake, escrowed by the contract." |
| 1:10–1:50 | The match: drop cards; each one's pill goes *sent → executed 300 ms → final 600 ms*; damage numbers; a tower falls in slow motion | "Every card is a Monad transaction while the unit walks the lane." |
| 1:50–2:10 | The result: $1.80 paid, chest granted; **▶ Replay from the chain** | "The second claim pays the pot, in the same transaction." |
| 2:10–2:30 | The replay: **✓ Verified against N on-chain checkpoints**; then **Live now → Watch**, a third window spectating another match from its logs | "Rebuilt from Monad and checked against the state hashes both players posted. Live matches too." |
| 2:30–2:45 | Empire: Monad network panel (staking epoch, proposer); **Verify a passkey on Monad** → ✓ by `0x0100` | "Monad's precompiles: native staking, and passkeys verified by the chain." |
| 2:45–3:00 | Clan war score (3 – 0 from a staked win), the season pass tier claimed, leaderboards, the CRE meta line | "Clans fight with real stakes, scored from the chain. Indexed by Envio, meta by Chainlink CRE. That's Mempire." |

## Verifiable evidence

Locally, today (reproduce with `./scripts/local-up.sh && ./scripts/test-all.sh`; details in [docs/QUALITY.md](docs/QUALITY.md)):

- **Contracts:** `forge test` 61/61, including the settlement-conservation fuzz test. Slither is triaged, with one hardening fix.
- **The whole game on a fork of Monad testnet:** `test-e2e.mjs` 25/25 covers:
  - onboarding with Agora's real faucet;
  - a BTC card minted on a live OKX quote;
  - the meta posted from momentum;
  - a $1 AUSD match staked with Agora's real permit, played, settled 90/10;
  - a chest opened and a merge;
  - a timeout refund.
- **Onboarding** 36/36, **settlement** 12/12, **persistence across a relay restart on MongoDB** 5/5, **Privy policy** 21/21, **Kimi** 46/46, **CRE** 33/33, **Envio handlers** 9/9.
- **Indexer on the fork:** `verify-local` 52/52, with every indexed row checked against the chain.
- **Simulation:** deterministic with and without the meta. The client and contract archetype derivations match for all 36 fighters.
- **Testnet, live (13 Oct)**, through the hosted app and relay (`app/e2e/live-smoke.mjs`, output in `docs/LIVE-SMOKE.json`):
  - two guests onboarded in 7–11 s each (starter deck minted by the relayer, MON drip, AUSD from Agora's faucet);
  - **match #1** staked in MON, played, and settled on chain: both seats' claims agree, on the CRE-written meta epoch 2986491;
    - a card play: [`0x9f648b9e…3258`](https://testnet.monadvision.com/tx/0x9f648b9ed4fecd5de8c2b39c729ea931d1d40f1dd8ae12e17e63c79f23153258);
    - the settling claim: [`0x8911e19b…7919`](https://testnet.monadvision.com/tx/0x8911e19bb5dad725d3681b94d919fcf290b4ba5c03e23669c829220baadf7919);
  - per-card speed receipts measured in the browser: executed 0.9–1.4 s, final 1.5–1.9 s (through public RPCs).
- **Chainlink CRE on testnet:** `cre workflow simulate --broadcast` wrote MetaPosted epoch 2986491 for 36 coins: [`0x26b6bc97…b219`](https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219).
- **Gasless chests on testnet** (EIP-7702 + ERC-4337 v0.8, our paymaster, the relay as bundler; `server/live-gasless.mjs`, output in `docs/LIVE-GASLESS.json`): a chest opened and revealed with the player's MON unchanged (0.27053934 before and after), 2 cards minted:
  - open, with the 7702 authorization: [`0xb0cec249…cc59`](https://testnet.monadvision.com/tx/0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59);
  - reveal: [`0x342a7b31…3c37`](https://testnet.monadvision.com/tx/0x342a7b31ee93e6ef99c96509003d2e18de1ba51b4262fcea993c820336103c37).
- **Hosting note:** the relay uses a Railway-hosted MongoDB, because the shared Atlas cluster does not yet allow Railway's IPs. Switching back is one variable (`MONGODB_URI`) once Atlas network access allows them.
