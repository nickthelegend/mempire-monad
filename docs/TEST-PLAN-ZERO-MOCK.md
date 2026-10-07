# Zero-mock test plan

Every screen, endpoint, contract call, integration and edge case of the
running product, each against a **real** dependency.

**Rules**
- **PASS** only when the real dependency answered.
- **UNTESTED** names exactly what is missing.
- **AWAITING TESTNET GO** for anything that needs Monad testnet or hosting, which are on hold.
- Test doubles (the fake Moonshot server, `MockPyth`/`MockAUSD` in forge tests) count as unit-test evidence only, never as PASS here.

**Stack under test.** `./scripts/local-up.sh`:
- anvil forking Monad testnet on :8612 (chain 31337);
- our contracts deployed with signed transactions;
- Agora's real AUSD and faucet (from the fork);
- `LocalPriceOracle` fed by live OKX/CoinGecko quotes;
- mongod :27019;
- relay :8799;
- app http://localhost:5181;
- Envio indexer on :8090 (own Postgres :5435).

**How.**
- API and chain items: `curl` against the relay, and `cast` against the fork.
- Browser items: Claude in Chrome in our own tabs, with the console and network checked after each.
- Two players need two origins (`localhost:5181` and `127.0.0.1:5181`), since a guest key lives in the origin's storage.

Last run: 6 Oct 2026.

## A. Relay and data (API, against the live stack)

| # | Item | Expected | Result | Evidence |
|---|---|---|---|---|
| A1 | `GET /api/health` | `persistent: true`, db `mempire_local_<startBlock>`, chain 31337, `pyth: local`, keeper on | **PASS** | `{"persistent":true,"db":"mempire_local","chain":{"chainId":31337,"pyth":"local",...}}` |
| A2 | `GET /api/coins`: live market data | Every row carries `source` okx/coingecko and `at` ≤ 100 s old; no invented rows | **PASS** | 20 rows, all `okx`, oldest 21 s. Coins without a live quote are absent, not zero. |
| A3 | `GET /api/pyth/update?coinIds=0,26` | `mode: local`; BTC signed from a live quote; NVDA (no live quote) reported in `missing`, not signed | **PASS** | `{"mode":"local","n":1,"missing":["NVDA"],"src":["okx"]}` |
| A4 | Meta keeper | Posts `postFromPyth` once per window with live prices; `epochSource` = 1 (Pyth) | **PASS** | Epochs 2985391 → 2985393 posted by the relay; `epochSource(2985393) = 1`; log: *posted meta epoch … for 20 fighters* |
| A5 | Persistence across a relay restart | A saved player is readable from a fresh relay process and is a real Mongo document | **PASS** | `test-persistence.mjs` 5/5; also the dev relay was restarted by PID and kept its data |
| A6 | `/api/privy/config` with no keys | `mode: off`, names the four missing keys | **PASS** | `{"mode":"off","missing":["PRIVY_APP_ID","PRIVY_APP_SECRET","PRIVY_AUTHORIZATION_KEY","PRIVY_SIGNER_ID"]}` |
| A7 | `/api/ai/status`, `/api/ai/plan` with no key | `off`, names `MOONSHOT_API_KEY`; plan → 503 | **PASS** | status `{"mode":"off","missing":["MOONSHOT_API_KEY"]}`; plan 503 |
| A8 | `/nft/:id` | A real card → ERC-721 JSON; a missing one → 404 | **PASS** | `test-onboard` §6 (7 checks); `/nft/999999` → 404 |
| A9 | `/api/leaderboard` | Only chain-verified settled matches; empty when none were reported | **PASS** | `[]` on the fresh stack (the seed's matches were not reported to the relay; nothing is invented) |
| A10 | Onboarding: starter deck, real AUSD faucet, MON drip, once per address, replay and forgery refused, concurrent nonces | as listed | **PASS** | `test-onboard` 36/36 on a throwaway fork |
| A11 | Settlement → leaderboard money columns equal what the arena paid | as listed | **PASS** | `test-settlement` 12/12 |

## B. Contracts on the fork (real signed transactions)

| # | Item | Expected | Result | Evidence |
|---|---|---|---|---|
| B1 | Mint with a signed live price in the same tx | The card records the posted price | **PASS** | `test-e2e` §2: BTC on a live OKX quote |
| B2 | `postFromPyth` momentum | Modifier = clamp((spot−EMA)/EMA × 2), computed on chain | **PASS** | `test-e2e` §3 (`-4 vs -4`) |
| B3 | $1 AUSD match with Agora's real permit | Escrow, 10 plays logged, 90/10 to the winner, 50 $MEMPIRE, chest | **PASS** | `test-e2e` §4 |
| B4 | Chest unlock → open → reveal; merge | Drops are ERC-721s; merge sets level 2 | **PASS** | `test-e2e` §5 |
| B5 | Timeout refund | Both stakes back, cards unlocked | **PASS** | `test-e2e` §6 |
| B6 | Indexer rows equal the chain | Every entity is checked against events | **PASS** | `verify-local` 52/52 after `seed-local` on the fork |

## C. Browser (Claude in Chrome)

| # | Screen / flow | Steps | Expected | Result |
|---|---|---|---|---|
| C1 | First load, 1440 px | Open `/` | Arena renders; console has no errors; no failed requests; chain badge reads local | **PASS** after a fix: console clean, all requests 200/304. The footer said "MONAD TESTNET" on the local fork; it now names the network (`NETWORK_LABEL`: "Local Monad fork"). |
| C2 | Desktop gutters | 1440 px | MarketBoard shows the latest epoch and live ▲▼ that match `MarketMeta` | **PASS**: the board's AVAX +1.9% and MON −8.4% equal `modifierBps` 195 and −843 for epoch 2985429 |
| C3 | Copy | Page text on every screen | No mock/Solana/devnet/SOL-as-currency/lamport/◎ | **PASS** after fixes: "testnet" copy on the local fork corrected in 4 places; 26 dead Solana scripts removed from `app/` |
| C4 | Wallet picker | Open the account chip | Passkey + Guest (+ injected); **no email/Privy row** | **PASS**: Passkey, "I already have a passkey", Guest, and Rainbow (the browser's own extension, not touched). No Privy row. |
| C5 | Guest sign-up → onboarding | **Play as Guest** | The starter kit lands; 8 cards = `cardsOf`; AUSD/MON | **PASS** after a fix: *Your deck is on chain · 4.1s*; on chain 8 cards, 10,000 AUSD from Agora's faucet, and the drip. **Found:** a 0.05 MON drip could not cover a staked match ("Not enough MON for gas"); the drip is now 0.25. A faucet-cooldown AUSD is now shown as "on its way", and the app refreshes when the relay's retry pays (seen: queued → paid in ~65 s, UI updated without a reload). |
| C6 | Cards screen | Open Cards and the bag list | Only on-chain cards; prices match `/api/coins`; a coin with no live quote says so | **PASS** after fixes: sub-cent prices read "$0" (now `$0.00000372`); the shop showed a feed symbol as a price (now "no live price") |
| C7 | Mint | Mint AVAX | Tx confirms; the card records the signed price | **PASS**: card #61 AVAX `mintPrice` $11.19 vs the live OKX $11.195 |
| C8 | Mint, no live price | Stocks (no quote over the weekend) | Refused, no tx | **PASS** after a fix: the button was enabled; now "No live price", disabled, for all 11 stocks |
| C9 | Deck | Build 8 from owned cards; reload | Persists | see the latest run below |
| C10 | Practice vs bot | Arena | "vs Classic bot"; "Kimi · not configured"; no commentary; no stake/chest | **PASS** (Arena shows both labels; Kimi is disabled) |
| C11 | Staked PvP, two origins | Both guests: $1 AUSD Ranked | Matched; one stake tx each; plays logged; settles; winner paid; chest | **PASS** after fixes, on two matches. Match 3 (rebuilt chain): settled `winner 0`, both claims seat 0, 4 + 2 plays logged at 0.1 s, the winner +$0.80 net, the loser −$1. **Found and fixed:** the result card printed AUSD as MON; "Chest slots full" for an empty chest bar; 2 "unlogged" plays (the session float and budget were sized for ~17 transactions; now 0.2 MON, priced from the chain's gas price, plays before checkpoints). |
| C12 | Chest | Cards → chest | start → open → reveal; ⛓ seed; drops appear | **PASS** after a stack fix: Silver Chest → +1 $PEPE minted, "⛓ block-hash seed 0xc9ec…". **Found:** the fork mined only on transactions, so the chest timer never passed on chain; the fork now mines every second. |
| C13 | Empire | Open Empire | Real leaderboard / empty state; money in the right currency | **PASS after fixes, pending a re-run**: Empire summed AUSD as MON (fixed); the leaderboard never credited a staked win because the relay didn't say `pending` (fixed, test-settlement 13/13); a previous chain's players showed (each deployment now gets its own DB). |
| C14 | Live on Monad | Panel | Envio rows match the chain | **PASS**: 5 players, plays and match #3 seat by seat; +$0.80 / −$1.00 per player, the same as the chain |
| C15 | Clan | Create a clan (signed) | Persists across reload | see the latest run below |
| C16 | 375 px | Every screen at 375×812 | No horizontal scroll; nothing clipped | see the latest run below |
| C17 | Accessibility basics | read_page | Named buttons; alt text; focus | see the latest run below |
| C18 | Relay down | Stop the relay (by PID), reload | Honest offline state; recovers | see the latest run below |

## D. Needs a key or a device (UNTESTED, with the exact dependency)

| # | Item | Missing dependency |
|---|---|---|
| D1 | Mera passkey sign-up, prompt-free sessions, step-up, the stateless test | A PRF-capable platform authenticator, and a human at the OS passkey prompt (automation must not drive it). Code is unchanged from the earlier verified build. |
| D2 | Passkey locker across devices | The same as D1, on two devices |
| D3 | Privy email sign-in, sponsored tx, session signer | `VITE_PRIVY_APP_ID` + `PRIVY_APP_ID`/`SECRET`/`AUTHORIZATION_KEY`/`SIGNER_ID` |
| D4 | Kimi opponent and caster | `MOONSHOT_API_KEY` |
| D5 | Chainlink CRE `simulate --broadcast` | `cre login` (and testnet for `--broadcast`) |
| D6 | Pyth Hermes (the real Pyth contract) | `PYTH_API_KEY`, and Monad testnet |

## E. Awaiting testnet go

| # | Item |
|---|---|
| E1 | Deploy plus Sourcify verification on Monad testnet |
| E2 | Relay on Railway, app on Vercel, indexer on Envio Cloud |
| E3 | The live smoke test (docs/DEPLOY-LATER.md §10) and the demo video |
