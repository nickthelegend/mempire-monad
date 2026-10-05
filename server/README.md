# Mempire relay (Monad)

Player state, the trophy ladder, clans, the PvP matchmaker, and the thin chain
layer the game needs a server for: onboarding new wallets, proxying Pyth
prices, serving card metadata, and verifying arena payouts before they reach the
leaderboard.

It stores results; the client owns game logic and money moves on chain, never
here. The only key this process signs with is the **relayer's**, which can mint
a once-per-address starter deck and pay a testnet drip — nothing more. A
compromised client cannot do anything through this API it could not already do
locally.

## Run it

```bash
npm install
npm run sync-shared        # vendor ../shared (roster, ABIs, deployments) into ./shared
npm run dev                # reads .env; see .env.example
```

No `MONGODB_URI` is fine: the relay boots on an in-memory store
(`memstore.js`), says so in its log and in `/api/health`, and forgets everything
on restart. Set `MONGODB_URI` for any deployment. `docker compose up --build`
brings a Mongo alongside the API.

The relay is deployed from this directory alone, so it cannot read `../shared`
at runtime. `npm run sync-shared` copies `roster.json`, `abi/` and
`deployments/` into `server/shared/`; rerun it and commit the result after any
contract redeploy or roster rebuild.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CHAIN_ID` | `10143` | Picks `shared/deployments/<CHAIN_ID>.json`. With no file, chain routes answer 503. `31337` = local anvil. |
| `RPC_URL` | `https://testnet-rpc.monad.xyz` | |
| `RELAYER_PRIVATE_KEY` | unset | Must be the address `MempireCards.relayer()` names. **Never the deployer/owner key** — boot refuses a key that owns a game contract. Unset = onboarding 503. |
| `AUSD_FAUCET` | unset | Agora testnet faucet (`0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`), `requestFunds(address)`. Test chains only. |
| `ONBOARD_MON_DRIP` | `0.05` | MON sent to a new address holding less than this. Test chains (10143, 31337) only, whatever this says. |
| `PYTH_API_KEY` | unset | Hermes has required a key since 2026-08-26. Unset = `/api/pyth/update` 503s and stocks drop out of `/api/coins`. |
| `PYTH_HERMES_URL` | `https://pyth.dourolabs.app/hermes` | |
| `COINGECKO_API_KEY` | unset | Optional demo key; the keyless tier works but rate-limits harder. |
| `PUBLIC_APP_URL` | `https://mempire.fun` | Base for NFT images: `<url>/art/card_<ticker>.png`. |
| `MONGODB_URI` | unset | Unset = in-memory store. |
| `MONGODB_DB` | `mempire` | |
| `CORS_ORIGIN` | unset (open) | Comma-separated origins. **Set this in production.** |
| `PORT` | `8787` | |

## Auth

Every write is signed. The client signs, with EIP-191 `personal_sign`, exactly:

```
Mempire
action: <action>
wallet: <address>
ts: <unix ms>
```

and sends `{ address, ts, signature }` in the body. The server rebuilds the
text from the address as sent, recovers the signer, and refuses anything more
than five minutes off, any signature already used (TTL'd replay store), and any
non-canonical signature (uppercase hex, high-s twins — one signature, one
spelling, or the replay store could be walked past). Handlers act as
`req.wallet`, never as an address read from the body.

**Addresses are stored lowercase everywhere** — Mongo ids, clan rosters,
pairing seats, onboarding claims. A checksummed and a lowercase address are one
account, one row, one claim. Anything that is not `0x` plus 40 hex characters is
a 400.

## Endpoints

**Health**
- `GET /api/health` — pings the store and reports `{ db, persistent, chain: { chainId, rpc, deployment, relayer } }`.

**Onboarding** (relayer-signed transactions, one serialized queue)
- `POST /api/onboard` — signed action `onboard`, body `{ address, ts, signature }`.
  Once per address (plus a per-IP limit). Mints the starter deck if
  `starterClaimed(address)` is false, requests AUSD from `AUSD_FAUCET`, and
  drips MON if the address holds less than the drip. Responds
  `{ ok, starter: 'minted'|'already'|'failed', ausd: 'sent'|'queued'|'unconfigured'|'failed', mon: 'sent'|'skipped'|'unconfigured'|'failed', txs, cardIds, starterCoins }`.
  `ausd: 'queued'` means the faucet's 60 s global cooldown refused it and the
  relay will retry. A second onboard is `409`; one whose earlier attempt left a
  step `failed` retries only that step.
- `GET /api/onboard/:address` — `{ starterClaimed, mon, ausd, claim }`.

The starter deck is eight distinct coins, the same for everyone: the
best-known coin of each of the six archetypes first, then the best-known
remainder (currently BTC SOL MON PEPE NVDA SHIB ETH DOGE). Archetype =
`keccak256(feedId) % 6`, computed in JS and checked against
`MempireCards.roster()` and `archetypeFor` at boot.

Every relayer transaction is gas-estimated and sent with a 15% margin — Monad
charges for the gas limit, not the gas used.

**Prices**
- `GET /api/pyth/update?coinIds=0,26` — `{ updateData: ['0x…'], prices: [{ coinId, price, expo, publishTime }] }`
  from Hermes, with our key, cached ~2 s. `price` is Pyth's raw integer as a
  string. 503 without `PYTH_API_KEY`.
- `GET /api/coins` — `[{ coinId, ticker, priceUsd, change24h }]` for the roster.
  Crypto and memecoins from CoinGecko (60 s cache, last good on failure),
  stocks from Pyth when keyed (`change24h: null` — Pyth's latest price has no
  24-hour change). A coin nobody quoted is omitted, never estimated.
  `x-data-age-seconds` says how old the list is.

**Card metadata**
- `GET /nft/:id` — ERC-721 metadata read from chain (`tokenURI` is
  `baseURI + id`): `$NVDA · Lv 3`, image, and ticker / kind / level /
  archetype (Tank, Swarm, Ranged, Splash, Support, Spell) attributes, plus the
  mint price at its Pyth exponent when non-zero. 404 for burned or unminted ids.

**Player state**
- `GET /api/player/:address` · `PUT /api/player/:address` (`player.put`)
- `POST /api/match/:address` (`match.post`) — records a match. An escrowed one
  names its arena `matchId`; the relay reads `MempireArena.getMatch` and credits
  the net in the match's own currency. A report before settlement is counted
  and returns `pending: true`; the retry credits the money, once
  (`match_credits` claims `${matchId}:${address}` first).
- `GET /api/leaderboard?currency=MON|AUSD` — top 25 by chain-verified net
  winnings. Rows carry both `netMon` and `netAusd`; they are never summed.
- `PUT /api/player` (`player.save`) · `POST /api/player/match` (`player.match`)

**Ladder**
- `GET /api/ladder/:address` · `POST /api/ladder/:address` (`ladder.post`) · `GET /api/ladder`

Elo, K=32, scale 400, with league floors. A report must cite the `pairKey` the
matchmaker sent both seats, and ratings move only once both seats agree.

**Clans**
- `GET /api/clans` · `GET /api/clans/:tag` · `GET /api/clans/mine/:address` · `GET /api/clans-top`
- `POST /api/clans` (`clan.create`) — the server allocates the tag. When this
  chain has a `$MEMPIRE` token, the body must carry `paymentTx`: a transaction
  that sent ≥ 250 $MEMPIRE from the founder to `MempireCards.treasury()`,
  checked by its Transfer logs. One payment, one clan.
- `POST /api/clans/:tag/{join,leave,role,kick,request,lend,crowns}` (`clan.<verb>`) · `PATCH /api/clans/:tag` (`clan.settings`)

**Analytics** — `POST /api/events` (`events`) · `GET /api/analytics/{summary,insights,ops}`.
In memory mode the aggregates are empty.

**WebSocket** — `/ws` on the same port. Matchmaking, lockstep input relay, and
the desync referee.

- `queue` `{ address, tier, currency: 'MON'|'AUSD' (default MON), format, ranked, deck, … }`.
  Pools are split by tier, currency, format and ranked, so stakes always match.
  Ranked requires the signed `queue` action; an unsigned ranked queue is
  demoted to casual.
- `matched` `{ matchId, pairKey, role, seed, startAt, serverNow, inputDelayTicks, format, currency, metaEpoch, opponent }`.
  The seed is chosen here at pairing for every match, staked or not — the
  battle starts at `startAt` while the arena create/join is still in flight.
  `metaEpoch` is `MarketMeta.currentEpoch()`, read once per pairing (cached at
  most 30 s, 0 if unavailable) so both seats apply identical market modifiers.
- `chain` `{ stage: 'opened'|'joined'|'failed', onchainMatchId, txHash }` —
  the escrow handshake, relayed verbatim and never acted on; both clients read
  `getMatch` themselves.
- `input`, `tick`, `hash`, `ended`, `cancel` as before.

## Routes removed in the Monad port

`GET/POST /api/faucet` (replaced by `/api/onboard`), the Bags `$MEMPIRE`
market (`/api/market/*`), and `GET /api/analytics/tvl`. The DexScreener coin
feed behind `/api/coins` is replaced by the roster feed above.

## Tests

Unit (no server, no chain):

| Command | Covers |
|---|---|
| `node test-auth.mjs` | Message text, skew window, malleated/uppercase signatures, address normalisation. |
| `node test-memstore.mjs` | The in-memory store against the query shapes the routes rely on. |

Against the local anvil deployment (`anvil` on `127.0.0.1:8611`, `shared/deployments/31337.json`).
Each starts its own in-memory relay:

| Command | Covers |
|---|---|
| `node test-onboard.mjs` | Eight starter cards covering all six archetypes, the MON drip, AUSD queued on faucet refusal, once per address (any letter case), bad/replayed signatures, three concurrent onboards with distinct nonces, estimated gas limits, `/nft/:id`. |
| `node test-settlement.mjs` | A real MON escrow through the arena: pending before settlement, credited once after, per-currency columns, unseated wallets credited nothing. |

Against a running relay (`API=http://host:port`, `WS=ws://host:port/ws`;
in-memory is fine, and use a chain without a `$MEMPIRE` deployment so clan
charters are free):

| Command | Covers |
|---|---|
| `node test-api.mjs` | Every route: existence, validation, signatures, response shape, WebSocket upgrade, body-size cap, rate limiting. |
| `node test-pvp.mjs` | Pairing, seed and `metaEpoch`, input relay, desync referee, forfeits, self-match in any case, currency pools, escrow handshake, ranked signatures. |
| `node test-clans.mjs` | Clan rules in depth — roles, permissions, membership. |
| `node test-ladder.mjs` | Elo, league floors, client/server drift guard, pairing-backed reports. |
| `node verify-api.mjs` | Status sweep of every route, including that the removed ones stay gone. |
| `node verify-matchmaker.mjs` | Two same-tier clients pair. |

`spar.mjs` and `spar-escrow.mjs` hold a queue slot for a browser to pair with;
`spar-escrow.mjs` (`SPAR_PRIVATE_KEY`, an onboarded key) also joins the
browser's arena match for real.

## What the container does that the bare process does not

- **Runs as non-root.** `node`, uid 1000, from the base image.
- **Ships production dependencies only**, from the lockfile (`npm ci --omit=dev`),
  plus `shared/`. `.dockerignore` keeps `.env` out of the build context entirely.
- **Has a real healthcheck** on `/api/health`.
- **Handles SIGTERM.** `CMD ["node", "index.js"]` rather than `npm start`.

## Rate limiting

Token bucket per IP on mutating routes (80, refill 5/s), per wallet once a
signature is proven (60, 2/s), a read bucket for routes that spend RPC or Hermes
quota (60, 2/s), and an onboarding bucket (10 signed attempts, then one a
minute). Shared through Mongo when configured; in process memory otherwise,
which is correct for the single process memory mode can be.
