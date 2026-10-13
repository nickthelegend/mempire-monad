# Portal copy (hackathon.monad.xyz)

Paste-ready. Every claim below is checkable on Monad testnet or in the repo.

## Name and tagline

- **Project name:** Mempire
- **Tagline (≤ 80):** A 1v1 card battler where every fighter is a real asset: the market is the meta

## Short description (≤ 280)

Coins and stocks become fighters, buffed or nerfed by the market via Chainlink CRE. Stake $1 (AUSD) or 0.01 MON, play a 3-minute lane battle where every card is a Monad transaction, and the contract pays the winner. One passkey prompt to start.

## Full description

**Problem.** Crypto games lose players in the first five minutes: seed phrases, extensions, faucets, popups mid-match. And "on-chain" games usually put only the result on chain, so nobody can check the match.

**Solution.** Mempire is a real-time 1v1 card battler. Every fighter is a real asset (BTC, MON, NVDA, BONK and 32 more). A Chainlink CRE workflow writes price moves on chain as small, bounded buffs and nerfs (one epoch per run), so the market is the meta. A new player signs in with one passkey prompt (Mera), and the relay mints an 8-card starter deck, gets test AUSD from Agora's faucet and sends gas. Two players stake (0.01 MON, or $1 AUSD with a permit), every card they drop is a Monad transaction from a per-match session key, and the second result claim settles the pot 90/10 in the same transaction. A staked match can be replayed: the relay keeps the seed and decks, and the replay re-runs the on-chain plays and checks them against the state hashes both players posted. Practice is free and off chain.

**Why Monad.** Fast blocks make it possible for every card drop in a staked match to be its own transaction while the unit walks the lane. The app shows it: Monad's commit states (proposed → voted ~290 ms → final ~575 ms) are live on the first screen. In a staked match each card shows "exec / final ms" as it lands; in the browser, through public RPCs, that measured 0.9–1.4 s executed and 1.5–1.9 s final (round trip included). It also uses what only Monad has:
- P256 passkey verification at `0x0100`;
- the staking precompile `0x1000`;
- EIP-7702 + an ERC-4337 v0.8 paymaster for gasless chests;
- gas sized for a chain that bills the limit;
- drips that respect the 10 MON reserve balance.

**What's live, honestly.** The app, the relay and 8 verified contracts are on Monad testnet. Proven there by the team's own test players:
- one staked MON match settled on chain;
- one CRE meta write (`cre workflow simulate --broadcast`; no DON deployment);
- one Pyth-priced mint;
- a gasless 7702 chest.

AUSD-permit stakes, replays and spectating are proven on a fork of testnet (test suites in the repo). Guests onboard on testnet in about 10 s.

## Track

03 · Social, Attention & Culture

## Bounties claimed

| Bounty | What it does in Mempire | Proof, and its limits |
|---|---|---|
| **Chainlink CRE** | A CRE workflow (TypeScript) reads CoinGecko and Pyth prices, reaches consensus over HTTP, and writes per-coin buffs/nerfs to `MarketMeta` through `writeReport`. Matches lock the epoch they start on | MetaPosted epoch 2986491 (36 coins): [0x26b6bc97…b219](https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219). It was sent with `cre workflow simulate --broadcast` through the simulation forwarder, because the workflow is not deployed to a DON. Live match #1 ran on that epoch. The app labels how old the meta is. |
| **Mera: Best UX** | "Create with passkey": one prompt, the account derived from WebAuthn PRF, no seed phrase or extension; a per-match session key signs card plays, so no popups during play | Live app (needs a PRF-capable passkey: iPhone, Android, recent Chrome/Safari); `app/e2e/browser-pass.mjs` runs it with a virtual authenticator |
| **Mera: Many Keys** | A second PRF namespace (`mempire.locker.v1`) feeds HKDF into an AES-256-GCM key: the Deck screen's **passkey locker** encrypts a deck and reopens it with the same passkey on any device. Monad's `0x0100` precompile also verifies P-256 passkey signatures (`PasskeyRegistry`) | Deck → Passkey locker, for passkey accounts (guests don't see it). The in-app precompile check uses a dedicated P-256 passkey and says so |
| **Privy** | Email sign-in into an embedded wallet; gas sponsorship; a session signer limited by a policy (only arena `play`/`checkpoint`/`claim`, value 0, chain 10143) | Signer key quorum and policy created on the Privy app via the API (`server/privy.js`; `/api/privy/config` shows them). No Privy transaction yet: the email path needs the Privy dashboard to allow this origin and enable Monad gas sponsorship |

Not claimed:
- **Envio:** built and tested (handlers 9/9; `verify-local` 52/52 on a fork), but not hosted.
- **Kimi:** off in the hosted app.

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
