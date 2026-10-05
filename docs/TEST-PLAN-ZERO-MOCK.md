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
| A1 | `GET /api/health` | `persistent: true`, db `mempire_local`, chain 31337, `pyth: local`, keeper on | **PASS** | `{"persistent":true,"db":"mempire_local","chain":{"chainId":31337,"pyth":"local",...}}` |
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
| C1 | First load, 1440 px | Open `/` | Arena renders; console has no errors; no failed requests; chain badge reads local | see below |
| C2 | Desktop gutters | 1440 px | MarketBoard shows the latest meta epoch and live ▲▼ values that match `/api/coins` and `MarketMeta` (no "advertise here") | see below |
| C3 | Copy | Page text on every screen | No "mock", "Solana", "devnet", "SOL" (as a currency), "lamport", "◎" | see below |
| C4 | Wallet picker | Open the account chip | Passkey + Guest (+ injected wallets if present); **no email/Privy row** (not configured) | see below |
| C5 | Guest sign-up → onboarding | **Play as Guest** | The starter kit lands; 8 cards appear; the count equals `cardsOf` on chain; AUSD/MON shown | see below |
| C6 | Cards screen | Open Cards and a card sheet | Only on-chain cards; the price/24h shown match `/api/coins`; a coin with no live quote says so | see below |
| C7 | Mint | Mint BTC from the shop | Tx confirms; the new card appears; its mint price equals the signed price | see below |
| C8 | Mint, no live price | Try to mint a coin missing from `/api/coins` | Refused with "no live price"; no tx sent | see below |
| C9 | Deck | Build 8 from owned cards | Saves; persists after reload (Mongo) | see below |
| C10 | Practice vs bot | Arena → Practice | The opponent is labelled "Classic bot"; "Kimi · not configured" is disabled; no commentary ticker; no stake; no chest | see below |
| C11 | Staked PvP, two origins | Both guests: MON Pauper → Battle | Matched; one stake tx each; plays logged (the badge counts); settle; the winner is paid; chest on chain | see below |
| C12 | Chest | Chests panel after the win | Only on-chain chests; start → open → reveal; ⛓ block-hash seed; drops appear | see below |
| C13 | Empire | Open Empire | Leaderboard rows are real (or an honest empty state); the settlement feed comes from the chain | see below |
| C14 | Live on Monad | Panel | Envio rows (seeded matches, plays) match `verify-local` | see below |
| C15 | Clan | Create a clan (signed) | Persists across a reload | see below |
| C16 | 375 px | Every screen at 375×812 | No horizontal scroll; controls ≥ 44 px; nothing clipped | see below |
| C17 | Accessibility basics | read_page on each screen | Buttons are named; images have alt text or are decorative; focus is visible | see below |
| C18 | Relay down | Stop the relay (by PID), reload | An honest offline state; no fake data; recovers when the relay is back | see below |

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
