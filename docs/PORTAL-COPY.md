# Portal copy (hackathon.monad.xyz)

Paste-ready. Every claim below is checkable on Monad testnet or in the repo.

## Name and tagline

- **Project name:** Mempire
- **Tagline (≤ 80):** A 1v1 card battler where every fighter is a real asset: the market is the meta

## Short description (≤ 280)

Coins and stocks become fighters, buffed or nerfed by today's market via Chainlink CRE. Stake a dollar, play a 3-minute lane battle where every card is a Monad transaction, and the contract pays the winner in one block. One passkey prompt to start.

## Full description

**Problem.** Crypto games lose players in the first five minutes: seed phrases, extensions, faucets, popups mid-match. And "on-chain" games usually put only the result on chain, so nobody can check the match.

**Solution.** Mempire is a real-time 1v1 card battler. Every fighter is a real asset (BTC, MON, NVDA, BONK and 32 more). A Chainlink CRE workflow writes today's price moves on chain as small, bounded buffs and nerfs, so the market is the meta. A new player signs in with one passkey prompt (Mera), and the relay mints an 8-card starter deck, gets test AUSD from Agora's faucet and sends gas. Two players stake a dollar (MON or AUSD with a permit), every card they drop is a Monad transaction from a per-match session key, and the second result claim settles the pot 90/10 in the same transaction. Any match can be replayed from its on-chain plays and checked against the state hashes both players posted, and live matches can be watched from the chain.

**Why Monad.** 300 ms blocks and ~600 ms finality make it possible for every card drop to be its own transaction while the unit walks the lane. The app shows it: Monad's commit states (proposed → voted → final) are live on the first screen, and each card shows "exec / final ms" as it lands. It also uses what only Monad has:
- P256 passkey verification at `0x0100`;
- the staking precompile `0x1000`;
- EIP-7702 + an ERC-4337 v0.8 paymaster for gasless chests;
- gas sized for a chain that bills the limit;
- drips that respect the 10 MON reserve balance.

**What's live.** The app, relay and 8 verified contracts are on Monad testnet. A live staked match was settled on chain, with real per-card timings measured in the browser.

## Track

03 · Social, Attention & Culture

## Bounties claimed

| Bounty | What it does in Mempire | Proof |
|---|---|---|
| **Chainlink CRE** | A CRE workflow (TypeScript) reads CoinGecko and Pyth prices, reaches consensus and writes per-coin buffs/nerfs to `MarketMeta` every epoch; matches lock the epoch they start on | MetaPosted epoch 2986491, 36 coins: [0x26b6bc97…b219](https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219); live match #1 ran on that epoch |
| **Mera: Best UX** | "Create with passkey": one prompt; the account comes from WebAuthn PRF; no seed phrase, extension or popups during play (a session key signs card plays) | Live app; `app/e2e/browser-pass.mjs` (virtual authenticator) |
| **Mera: Many Keys** | The same passkey restores the same account on any device; a P-256 passkey signature is also verified on chain by Monad's `0x0100` precompile (`PasskeyRegistry`) | `PasskeyRegistry` deployed and verified; in-app check by live `eth_call` (12,773 gas vs 353,980 in Solidity) |
| **Privy** | Email sign-in to an embedded wallet; gas sponsorship; a session signer limited by a policy (only arena `play`/`checkpoint`/`claim`, value 0, chain 10143) | Signer and policy created on the app via the API (`server/privy.js`); email sign-in turns on once the dashboard origins are allowed |
| **Envio** | HyperIndex indexer for matches, players, coins, cards and daily stats, feeding the live feed and leaderboards | Handlers 9/9; `verify-local` 52/52 on a fork |

## Links

- **Repo:** https://github.com/nickthelegend/mempire-monad
- **Live app:** https://mempire-monad.vercel.app
- **Relay:** https://relay-production-9c75.up.railway.app/api/health

## Contracts (Monad testnet 10143, verified on Sourcify)

| Contract | Address |
|---|---|
| MempireArena | [0xec897071929657b898C18513EF85EC8A8f898Ea3](https://testnet.monadvision.com/address/0xec897071929657b898C18513EF85EC8A8f898Ea3) |
| MempireCards | [0xde510Aa056ab8fA5B867Ac9fEF90a9c6CB37dC22](https://testnet.monadvision.com/address/0xde510Aa056ab8fA5B867Ac9fEF90a9c6CB37dC22) |
| MempireToken ($MEMPIRE) | [0xFe140f43017CaA1f201f9e1DC7989c1F70f45234](https://testnet.monadvision.com/address/0xFe140f43017CaA1f201f9e1DC7989c1F70f45234) |
| MarketMeta | [0x17Ca9e2102d2B38f3676fEc6B5EA6c927753d148](https://testnet.monadvision.com/address/0x17Ca9e2102d2B38f3676fEc6B5EA6c927753d148) |
| SeasonPass | [0xC9fce06d747cce76Ce17C019d935795E0cE49203](https://testnet.monadvision.com/address/0xC9fce06d747cce76Ce17C019d935795E0cE49203) |
| PasskeyRegistry | [0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd](https://testnet.monadvision.com/address/0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd) |
| MempirePaymaster | [0xDe9359912EFcc3Acf3cD4c5797353B106bF0be6C](https://testnet.monadvision.com/address/0xDe9359912EFcc3Acf3cD4c5797353B106bF0be6C) |
| MempireAccount7702 | [0x01b0950208B7E02c5361314c8DB4FF40042278dE](https://testnet.monadvision.com/address/0x01b0950208B7E02c5361314c8DB4FF40042278dE) |

## Three best transactions

1. A staked match settled on chain, live match #1 (the second result claim pays the pot): [0xa89f61a6…a492](https://testnet.monadvision.com/tx/0xa89f61a661c923543975062b060af5d0df2e7ebd6af0dba1a61f1901a6f5a492)
2. Chainlink CRE writing the market meta: [0x26b6bc97…b219](https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219)
3. A gasless chest, opened with an EIP-7702 authorization through the canonical EntryPoint v0.8, the player's MON unchanged: [0xb0cec249…cc59](https://testnet.monadvision.com/tx/0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59)

## Team and attribution

- Built by Nivesh Gajengi (nickthelegend).
- The game client, art, audio, simulation, matchmaker and clans were ported from the author's Solana version of Mempire (Jul–Aug 2026).
- All on-chain work, Monad-native features and sponsor integrations are new for Metropolis. See README → Attribution.

## AI tools disclosure

- Claude Code (Anthropic) wrote most of the code, tests and docs, under the author's direction and review.
- Higgsfield generated the art, earlier, for the Solana version.
- No AI model runs in the product: the Kimi opponent is switched off and the classic bot plays.
