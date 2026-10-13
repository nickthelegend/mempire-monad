# Mempire — portal form (hackathon.monad.xyz → "Complete your entry")

Paste field by field, in this order. Every claim is checkable on Monad testnet (chain 10143).

---

## 1. Primary track
03 · Social, Attention & Culture

## 2. Logo
`docs/brand/logo-portal.png` (1200×1200 PNG, 476 KB)

## 3. Project name
Mempire

## 4. Tagline
A 1v1 card battler where every fighter is a real asset and the market is the meta. Stake, play, and every card is a Monad transaction.

## 5. Description

**PROBLEM**
Crypto culture lives on charts, but it has nowhere to play. Games with real stakes still start with seed phrases, extensions, faucets and wallet popups, and most put only the final result on chain, so nobody can check the match.

**SOLUTION**
Mempire is a real-time 1v1 lane battler.
- **Fighters are real assets.** BTC, memecoins and stocks. A Chainlink CRE workflow writes the market's price moves on chain as small, bounded (±15%) buffs and nerfs, so the market is the meta.
- **Sign-up is one passkey prompt** (Mera). The relayer then mints an 8-card starter deck (ERC-721), gets test AUSD from Agora's faucet and drips a little MON for gas.
- **Stakes are real and settled by the contract.** Two players stake (0.01 MON, or $1 AUSD with an EIP-2612 permit) and play a 3-minute match. Every card is a Monad transaction from a per-match session key, so there are no popups. The second player's result claim settles the pot 90/10 in that same transaction.
- **New fighters mint at a live Pyth price**, inside the mint transaction.
- **Clans and clan wars are the social layer.** They are scored only by staked wins the relay has verified on chain.
- **Chests can be opened gaslessly**, through EIP-7702 and our own ERC-4337 paymaster.

**WHY MONAD**
A transaction per card only works on a chain this fast. In the browser we measure blocks voted in about 290 ms and final in about 575 ms (`monadNewHeads`). Each card in a staked match shows its real round trip: executed, then final.

Mempire also uses what is native to Monad:
- the P256 precompile (0x0100), which verifies passkey signatures (12,773 gas vs 353,980 in Solidity);
- the staking precompile (0x1000), read through Multicall3;
- EIP-7702 with the canonical EntryPoint v0.8;
- explicit gas limits, because Monad bills the limit;
- relayer drips that respect the 10 MON reserve balance.

**WHAT'S LIVE (Monad testnet)**
- **App:** https://mempire-monad.vercel.app, with a hosted relay.
- **8 contracts, verified on Sourcify (MonadVision):** Arena 0xec897071929657b898C18513EF85EC8A8f898Ea3, Cards 0xde510Aa056ab8fA5B867Ac9fEF90a9c6CB37dC22, $MEMPIRE 0xFe140f43017CaA1f201f9e1DC7989c1F70f45234, MarketMeta, SeasonPass, PasskeyRegistry, MempirePaymaster, MempireAccount7702.
- **Chainlink CRE write:** 0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219. It was sent with `cre workflow simulate --broadcast`; the workflow is not deployed to a DON.
- **Pyth-priced mint:** 0x313623fdcef0eb2423ce822aa34812f59efe0df0a06671425f84551a1968886a.
- **Gasless chest** (type-4 tx with an EIP-7702 authorization): 0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59.
- **A staked match settled on chain:** 0x8911e19bb5dad725d3681b94d919fcf290b4ba5c03e23669c829220baadf7919 (MatchSettled).
- **Demo activity, seeded by the team (not organic users):** 8 wallets, 7 settled staked matches, 3 clans with members, a running clan war, 3 gasless chests. Every tx is in docs/evidence/seed-13oct.md.
- **Live proof page:** https://mempire-monad.vercel.app/proof.html reads any of these transactions straight from the RPC.

**KNOWN LIMITS (honest)**
- Ranked-match replays currently report a divergence from the chain at the first checkpoint; settlement itself is unaffected.
- The hosted relay uses a Railway MongoDB.
- The Pyth key covers 7 of 36 feeds, so the other fighters show "no live price" and can't be minted.

## 6. First users, and how we reach them
**First users**
Crypto-native casual players aged 18–35 who already follow memecoins and tickers on X, Telegram and Discord. They want something fun with real (small) stakes, and they bounce off wallet setup. Second: memecoin communities that want a place to show up for their coin.

**How we reach them**
1. **Community clans.** We seed one clan per coin community (BONK, PEPE, WIF and so on) and run weekly clan wars. A community wins by staking and winning, which gives people a reason to recruit each other.
2. **The market as content.** A daily "buffed / nerfed" post generated from the on-chain meta: "$BTC +0.2%, $BOME −5.7% today". It is shareable and changes every day.
3. **Zero-friction links.** One passkey prompt and a free starter deck mean a shared link becomes a played match in under a minute, with no wallet to install.
4. **Monad ecosystem channels.** Testnet campaigns and Monad community game nights with $1 tiers, and creator streams of clan wars.
5. **Season pass.** A season pass for $MEMPIRE gives returning players goals (golden chests at 1/3/5/8 staked wins), priced honestly as a sink, not an investment.

## 7. Repo URL
https://github.com/nickthelegend/mempire-monad

## 8. Live app URL
https://mempire-monad.vercel.app

## 9. Demo video (≤ 3:00, working product only)
Upload `docs/demo/mempire-demo.mp4` (with `docs/demo/mempire-demo.srt`) to YouTube or Loom (unlisted is fine) and paste the link.

## 10. Pitch video (≤ 2:00)
Upload `docs/demo/mempire-pitch.mp4` and paste the link.

Team: [user fills in]

## 11. Testing instructions for judges
**No login needed.** Open https://mempire-monad.vercel.app on desktop or phone.
- Network: Monad testnet, through our relay; nothing to configure.
- Optional: use a passkey-capable device (iPhone, Android, recent Chrome or Safari) for Mera passkey sign-up.

**Step by step**
1. **Landing.** The "Monad testnet heartbeat" shows live blocks: proposed → voted (~290 ms) → final (~575 ms).
2. **Play now.** Choose **Create with passkey** (one prompt), or **Play as Guest**. In about 10 s, "Your deck is on chain" appears: 8 ERC-721 fighters, 10,000 test AUSD and 0.4 MON for gas, sent by our relayer.
3. **Cards.** Each fighter shows its live price, 24h move and on-chain meta. Press **Mint · 0.01 MON** on a priced fighter (BTC, ETH, SOL, BNB, XRP, DOGE or TSLA). The Pyth update is posted inside the mint transaction.
4. **Arena.** Pick **MON** and the **$1** tier. To play a staked match you need an opponent: open a second browser or a phone, sign in as a guest, and press **Ranked** on both. Each card you drop shows "exec · final ms". When the match ends, the second claim settles the pot (90/10) on chain.
5. **Clan.** Join a clan (Diamond Hands and Bridge Burners are in a running clan war; they were seeded by the team) and see the war panel.
6. **Empire.**
   - The leaderboards.
   - Monad's staking precompile, read live.
   - **Verify a passkey on Monad**: a P-256 signature checked by the 0x0100 precompile, with a tampered copy refused.
7. **Proof.** Open https://mempire-monad.vercel.app/proof.html?tx=CRE~0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219,Gasless~0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59 to read the transactions live from the chain.

**Notes and caps**
- **Onboarding** is rate-limited per IP: 10 onboards, refilling one per minute.
- **The public Monad RPC** can rate-limit. The app falls back to other RPCs automatically.
- **Only 7 fighters can be minted**, because the Pyth plan covers 7 of 36 feeds. The rest are labelled.
- **Kimi** (the AI opponent) is off; the classic bot plays Practice for free.

## 12. Bounties

### Chainlink CRE
- **Published article:** https://github.com/nickthelegend/mempire-monad/blob/main/docs/CHAINLINK-CRE.md
- **What it does:** a TypeScript CRE workflow (cron and HTTP triggers) fetches CoinGecko and Pyth prices, takes a per-coin median consensus, and writes a report through `writeReport` to `MarketMeta` (forwarder-gated, ±15% clamp). Each match locks the meta epoch it starts on, and the game simulation applies it as stat buffs and nerfs.
- **Evidence:**
  - MetaPosted epoch 2986491, 36 coins: tx 0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219, sent with `cre workflow simulate --broadcast` through the simulation forwarder 0xB9F79d863261869B234c481D1f9A7af84AeAd192.
  - Live match #1 used that epoch.
  - Code: `cre/market-meta/` (33 tests).
- **Limit:** not deployed to a DON.

### Mera: Best UX
- **Published article:** https://github.com/nickthelegend/mempire-monad/blob/main/docs/MERA.md
- **What it does:** "Create with passkey" is one WebAuthn prompt. The account's secp256k1 key is derived from the passkey's PRF output, with no seed phrase and nothing secret stored. A per-match session key signs card plays, so there are no popups during play.
- **Evidence:** the live app (needs a PRF-capable passkey); `app/e2e/browser-pass.mjs` runs it with a virtual authenticator.

### Mera: Many Keys
- **Published article:** https://github.com/nickthelegend/mempire-monad/blob/main/docs/MERA.md
- **What it does:**
  - A second PRF namespace (`mempire.locker.v1`) feeds HKDF into an AES-256-GCM key. The Deck screen's **passkey locker** encrypts a deck and reopens it with the same passkey on any device.
  - Monad's P256 precompile (0x0100) verifies passkey signatures, through `PasskeyRegistry` (deployed 0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd) and in the app's "Verify a passkey on Monad" check.
- **Evidence:** the Deck screen (for passkey accounts) and the Empire screen.

*(Not claimed: Privy (set up, but no Privy transaction yet), Envio (built, not hosted) and Kimi (off).)*

## 13. Optional promo clip (≤ 0:30)
`docs/demo/mempire-promo.mp4`

## 14. X link
[user fills in]
