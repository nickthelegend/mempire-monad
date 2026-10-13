# Mempire: portal entry

Paste top to bottom. Counts are characters as typed. One live URL everywhere: https://mempire-monad.vercel.app

## Primary track
> Your project is judged in one track. Choose it before you add bounties.
Social, Attention & Culture

## Project details
### Logo
> PNG, JPG, or WEBP · Max 2 MB · At least 500 px · Up to 2000 × 2000 px
docs/brand/logo-portal.png (1200×1200, 465 KB)

### Name   (7 / 120)
Mempire

### Tagline   (139 / 200)
A 1v1 card battler where every coin is a fighter and the market is the meta. Stake, battle, and every card you play is a Monad transaction.

### Description   (3075 / 8,000)
PROBLEM
Crypto culture lives on charts, but it has nowhere to play. Games with real stakes still start with seed phrases, extensions, faucets and wallet popups, and most put only the final result on chain, so nobody can check the match.

SOLUTION
Mempire is a real-time 1v1 lane battler where every fighter is a real asset: BTC, memecoins and tokenised stocks. A Chainlink CRE workflow writes the market's price moves on chain as small, bounded (±15%) buffs and nerfs, so the market is the meta. A new player signs up with one passkey prompt (Mera); the relayer mints an 8-card starter deck (ERC-721), sends test AUSD from Agora's faucet and a little MON for gas. Two players stake (0.01 MON, or $1 AUSD with an EIP-2612 permit) and play a 3-minute match. Every card is a Monad transaction from a per-match session key, so there are no popups, and the second player's result claim settles the pot 90/10 in the same transaction. New fighters mint at a live Pyth price. Clans and clan wars, scored only by staked wins verified on chain, are the social layer. Chests can be opened gaslessly through EIP-7702 and our own ERC-4337 paymaster.

WHY MONAD
A transaction per card only works on a chain this fast: we measure blocks voted in ~290 ms and final in ~575 ms in the browser (monadNewHeads), and each card shows its real round trip, executed then final. Mempire also uses Monad-native pieces: the P256 precompile (0x0100) verifies passkey signatures (12,773 gas vs 353,980 in Solidity), the staking precompile (0x1000) is read through Multicall3, EIP-7702 runs with the canonical EntryPoint v0.8, gas limits are explicit because Monad bills the limit, and relayer drips respect the 10 MON reserve balance.

WHAT'S LIVE (Monad testnet)
- App and hosted relay: https://mempire-monad.vercel.app
- 8 contracts, verified on Sourcify: Arena 0xec897071929657b898C18513EF85EC8A8f898Ea3, Cards 0xde510Aa056ab8fA5B867Ac9fEF90a9c6CB37dC22, $MEMPIRE 0xFe140f43017CaA1f201f9e1DC7989c1F70f45234, MarketMeta 0x17Ca9e2102d2B38f3676fEc6B5EA6c927753d148, SeasonPass, PasskeyRegistry, MempirePaymaster, MempireAccount7702.
- Chainlink CRE write (cre workflow simulate --broadcast): 0x1f05618103c9b7c1ebc6afe32bf3f88255b9a9c69ee79078695bb480bbb1317a.
- Pyth-priced mint: 0x313623fdcef0eb2423ce822aa34812f59efe0df0a06671425f84551a1968886a.
- Gasless chest (type-4 tx with an EIP-7702 authorization): 0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59.
- A staked match settled on chain: 0x8911e19bb5dad725d3681b94d919fcf290b4ba5c03e23669c829220baadf7919 (MatchSettled).
- Demo activity seeded by the team (not organic users): 8 wallets, 7 settled staked matches, 3 clans with members, a running clan war, 3 gasless chests.
- Live proof page that reads any of these txs from the RPC: https://mempire-monad.vercel.app/proof.html

Known limits: the CRE workflow runs through the CRE simulator (not yet on a DON); ranked replays currently report a divergence at the first checkpoint (settlement is unaffected); the Pyth key covers 7 of 36 feeds, so other fighters can't be minted yet.

### First users + how we reach them   (1112 / 8,000)
FIRST USERS
1. Crypto-native casual players (18–35) who follow memecoins and tickers on X, Telegram and Discord, want something fun with small real stakes, and bounce off wallet setup.
2. Memecoin and token communities that want a place to show up for their coin.
3. Monad testnet users looking for a game that uses the chain's speed in every move.

HOW WE REACH THEM?
1. Community clans: we seed one clan per coin community (BONK, PEPE, WIF…) and run weekly clan wars; a community wins by staking and winning, so members recruit each other.
2. The market as content: a daily "buffed / nerfed" post from the on-chain meta ("$BTC +0.6%, $PEPE −2.4% today"), shareable and new every day.
3. Zero-friction links: one passkey prompt and a free starter deck turn a shared link into a played match in under a minute, with no wallet to install.
4. Monad ecosystem channels: testnet campaigns, community game nights at the $1 tier, and creator streams of clan wars.
5. Season pass: a $MEMPIRE season pass gives returning players goals (golden chests at 1/3/5/8 staked wins), priced honestly as a sink, not an investment.

### Repository
> Public, or shared with metropolis@hackathon.monad.xyz.
https://github.com/nickthelegend/mempire-monad

## Demo and pitch
### Live URL
> Must run on Monad Mainnet or Testnet.
https://mempire-monad.vercel.app

### Demo video  (upload docs/demo/mempire-demo.mp4 → paste ONE video link: YouTube unlisted, Loom or Vimeo)
> Show the working product, not slides or a code walkthrough. Up to 3 minutes.
docs/demo/mempire-demo.mp4 (2:50, live on Monad testnet; captions in mempire-demo.srt)
[ ] Let organizers show it publicly (the user decides)

### Pitch video  (upload docs/demo/mempire-pitch.mp4 → paste ONE video link)
> Introduce your team, the problem you solve, and why you are building it. Up to 2 minutes.
docs/demo/mempire-pitch.mp4 (1:24)
Team: [user fills in]

### Judge testing instructions   (2042 / 8,000)
> Private to your team, judges, and organizers.
No login needed. Open https://mempire-monad.vercel.app on desktop or phone. Network: Monad testnet (chain 10143), through our hosted relay; nothing to configure, no faucet needed (the relayer funds new players).

1. Landing: the "Monad testnet heartbeat" shows live blocks: proposed → voted (~290 ms) → final (~575 ms).
2. Play now → "Create with passkey" (one prompt; needs a PRF-capable passkey: iPhone, Android, recent Chrome/Safari) or "Play as Guest". In ~10 s "Your deck is on chain": 8 ERC-721 fighters, 10,000 test AUSD and 0.4 MON for gas.
3. Cards: each fighter shows its live price, 24h move and on-chain meta. Press "Mint · 0.01 MON" on a priced fighter (BTC, ETH, SOL, BNB, XRP, DOGE, TSLA); the Pyth update is posted inside the mint transaction.
4. Arena: pick MON and the $1 tier. A staked match needs two players: open a second browser (or a phone), sign in as a guest, and press Ranked on both. Every card you drop shows "exec · final ms". When the match ends, the second claim settles the pot 90/10 on chain. Practice (free) plays the bot with no stake.
5. Clan: open "Diamond Hands" (seeded by the team) and press Join; the clan war panel shows the running bracket.
6. Empire: your record, the leaderboards, Monad's staking precompile read live, and "Verify a passkey on Monad" (a P-256 signature checked by the 0x0100 precompile, with a tampered copy refused).
7. Proof: https://mempire-monad.vercel.app/proof.html?tx=CRE~0x1f05618103c9b7c1ebc6afe32bf3f88255b9a9c69ee79078695bb480bbb1317a,Gasless~0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59 reads the transactions live from the chain.

Notes and caps:
- Onboarding is rate-limited per IP (10, refilling one per minute).
- The public Monad RPC can rate-limit; the app falls back to other public RPCs.
- Only 7 fighters can be minted today (our Pyth plan covers 7 of 36 feeds); the rest are labelled.
- The Kimi AI opponent is off; the classic bot plays Practice.
- Clans, the clan war and part of the leaderboard are demo activity seeded by the team.

## Bounties

### Best workflow with CRE   (Chainlink)
**Describe how CRE is used as an orchestration layer in your project**   (1610 chars)
Mempire's market meta (the daily buffs and nerfs that change how strong each fighter is in staked matches) is orchestrated by a Chainlink CRE workflow, not by our server. The workflow (cre/market-meta/, TypeScript) runs on a cron trigger each epoch (10-minute windows). In node mode each node fetches 24h price changes over HTTP (CoinGecko for crypto, Pyth Hermes for stocks); CRE aggregates them with a per-coin median (ConsensusAggregationByFields), which tolerates nodes that lag or see a different edge cache, where a byte-identical array would routinely miss quorum. Each agreed move is mapped to a bounded modifier (at most ±15%), encoded as (epoch, coinIds[], bps[]), signed with runtime.report() and written to Monad with evm.writeReport() into our MarketMeta contract (contracts/src/MarketMeta.sol). The workflow first reads currentEpoch on chain and skips stale epochs. MarketMeta.onReport accepts only the forwarder (optionally only our workflow owner), refuses stale epochs, re-clamps every value on chain and emits MetaPosted. The game then consumes it: the matchmaker reads currentEpoch, the arena records each match's metaEpoch, and both clients build the same deterministic simulation from modifierBps, so the numbers that decide staked outcomes come from CRE consensus, verifiable per match. A permissionless postFromPyth path shares the epoch clock as a fallback writer, and epochSource records which writer set each epoch. Honest limit: the workflow runs via `cre workflow simulate --broadcast` through the CRE simulation forwarder; it is not deployed to a DON yet. 33 unit tests (bun test).

**Video (≤ 2:00) of a CRE CLI simulation or live deployment** (required)
docs/demo/bounty-cre.mp4 (1:05: the real `cre workflow simulate --broadcast` run, its MetaPosted tx read live from Monad, and the arena updating) → upload, paste the link

**What we did**
- A TypeScript CRE workflow (cron trigger, HTTP fetches, per-coin median consensus, signed report, EVM write) that computes Mempire's market meta.
- A MarketMeta receiver on Monad that accepts only the forwarder, refuses stale epochs and re-clamps values on chain.
- Wired into the game: every staked match locks the epoch, and both clients simulate with those numbers.
- Article: https://github.com/nickthelegend/mempire-monad/blob/main/docs/CHAINLINK-CRE.md

**Evidence**
- Latest CRE write, epoch 2986556, 36 coins: https://testnet.monadvision.com/tx/0x1f05618103c9b7c1ebc6afe32bf3f88255b9a9c69ee79078695bb480bbb1317a
- Earlier CRE write, epoch 2986491, used by live match #1: https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219
- MarketMeta (verified): https://testnet.monadvision.com/address/0x17Ca9e2102d2B38f3676fEc6B5EA6c927753d148

### Best Mera-Powered UX on Monad   (Monad Foundation · Mera)
**Describe how Mera is used as the entire account layer**   (1308 chars)
Mera is Mempire's entire account layer. "Create with passkey" runs one WebAuthn ceremony through Mera (@category-labs/mera) with a PRF extension salt for our account namespace. The 32 bytes the authenticator returns are a deterministic function of (credential, domain, salt); they become the BIP-39 entropy of a phrase the player never sees, the key is derived at m/44'/60'/0'/0/0 and handed straight into a Mera Secp256k1 signing session (createSecp256k1SigningSession), and every intermediate (PRF output, seed, private key) is zeroed. toViemAccount turns the session into the viem account that signs every Monad transaction: the starter-deck flow, Pyth-priced mints, stakes and claims. Nothing secret is stored; only the credential id and address are kept as a hint, and clearing them loses nothing, because the same passkey brings back the same account on any device it syncs to. There is no seed phrase, no extension and no custody backend. In matches a per-match session key (funded inside the stake tx) signs each card play, so a full staked battle runs with zero wallet popups. Code: app/src/lib/passkey.ts. Evidence: the passkey account created in our demo, 0x6A41c085c9B0FCE41bAda0B9e31d8e0Af14a55C4, holds 9 cards (8 starters + 1 mint it signed) and has sent its own transactions on Monad testnet.

**Video (≤ 2:00), UX-focused** (optional)
docs/demo/bounty-mera.mp4 (1:04: passkey sign-up → deck on chain → passkey-signed mint → popup-free staked battle → P-256 check) → upload, paste the link

**What we did**
- Passkey-only accounts with Mera: one prompt, a deterministic EOA from PRF, nothing secret stored.
- A per-match session key, so a staked battle has no popups.
- Relayer onboarding: starter deck, AUSD and gas in ~10 s.
- Article: https://github.com/nickthelegend/mempire-monad/blob/main/docs/MERA.md

**Evidence**
- Passkey account from the demo: https://testnet.monadvision.com/address/0x6A41c085c9B0FCE41bAda0B9e31d8e0Af14a55C4

### Mera: One Passkey, Many Keys   (Monad Foundation · Mera)
**Describe how Mera is used beyond the account (a PRF namespace for non-account work)**   (1145 chars)
Beyond the account, Mempire uses a second, unrelated PRF namespace from the same passkey: the passkey locker (app/src/lib/locker.ts) evaluates the salt "mempire.locker.v1", gets 32 bytes unrelated to the account key, and runs HKDF-SHA-256 with two distinct info labels: "mempire/locker/id" for an unlinkable storage id and "mempire/locker/aes-256-gcm" for an AES-256-GCM key. On the Deck screen a passkey player can encrypt a deck and reopen it with the same passkey on any device; only ciphertext is stored and the PRF output is zeroed as soon as HKDF has it. Separately, Monad's P-256 precompile (0x0100) verifies passkey signatures: PasskeyRegistry (0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd, verified) binds and verifies WebAuthn assertions with P256.verifyNative (12,773 gas vs 353,980 for a Solidity verifier), and Empire's "Verify a passkey on Monad" signs a fresh challenge and has the precompile check it, with a tampered copy refused. Honest limits: the locker is shown to passkey accounts only (guests don't have a PRF); the in-app P-256 check is a read-only eth_call, and binding through PasskeyRegistry has no live transaction yet.

**Video (≤ 2:00)** (optional)
docs/demo/bounty-mera.mp4 (its last segment shows the P-256 passkey check; the locker is not in a video)

**What we did**
- A second PRF namespace for an encrypted, cross-device deck locker (HKDF → AES-256-GCM plus an unlinkable id).
- On-chain passkey verification with Monad's P-256 precompile (PasskeyRegistry plus the in-app check).
- Article: https://github.com/nickthelegend/mempire-monad/blob/main/docs/MERA.md

**Evidence**
- PasskeyRegistry (verified): https://testnet.monadvision.com/address/0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd

*Not claimed:*
- *Privy!: set up, but with no Privy transaction, it isn't a working integration.*
- *Best Use of Envio: built and tested, but not hosted.*
- *Best Community Team Project: [user decides].*

## Optional promotion
### Promo video (≤ 30 s): docs/demo/mempire-promo.mp4 (0:25) → upload, paste the link
### X link: [user fills in]
