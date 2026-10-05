# Mempire API

Player state, the trophy ladder, clans, and the PvP matchmaker. The browser
cannot talk to Mongo directly, so this sits in between. It stores results; the
client owns game logic and money moves onchain, never here — a compromised
client cannot do anything through this API it could not already do locally.

## Run it

```bash
docker compose up --build -d
node test-api.mjs        # 30 assertions across all 22 routes
```

That is the whole setup. Compose brings a Mongo alongside the API, so the stack
runs with **no external accounts and no credentials at all** — which is the
point, not a convenience: it makes CI trivial, it makes cloning this repo
trivial, and it means nothing has to be trusted while the Atlas password that
was previously in use is rotated.

For a hosted deployment, drop the `mongo` service and point `MONGODB_URI` at the
managed cluster. Nothing else changes.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://mongo:27017` | Required. The process exits rather than starting without one. |
| `MONGODB_DB` | `mempire` | |
| `PORT` | `8787` | |
| `CORS_ORIGIN` | unset (open) | Comma-separated origins. **Set this in production** — unset means any site can call the API with a user's address. |

## Endpoints

All JSON. Addresses are validated against the base58 Solana pubkey shape before
they reach the database.

**Health**
- `GET /api/health` — pings Mongo and names the database. Deliberately does more
  than return 200: a health check that only proves the process is alive lets a
  deployment with a dead database pass its readiness probe.

**Player state**
- `GET /api/player/:address` · `PUT /api/player/:address`
- `POST /api/match/:address` — records a settled match
- `GET /api/leaderboard` — top 25 by net SOL

**Ladder**
- `GET /api/ladder/:address` · `POST /api/ladder/:address` · `GET /api/ladder`

Elo, K=32, scale 400, with league floors. The server is authoritative because it
is the only party that sees both sides of a match.

**Clans**
- `GET /api/clans` · `GET /api/clans/:tag` · `GET /api/clans/mine/:address` · `GET /api/clans-top`
- `POST /api/clans` — **the server allocates the tag** and returns it; it is not
  supplied by the caller
- `POST /api/clans/:tag/{join,leave,role,kick,request,lend,crowns}`
- `PATCH /api/clans/:tag`

**Coins**
- `GET /api/coins`

**WebSocket** — `/ws` on the same port. Matchmaking, lockstep input relay, and
the desync referee.

## What the container does that the bare process does not

- **Runs as non-root.** `node`, uid 1000, from the base image.
- **Ships production dependencies only.** Multi-stage, `npm ci --omit=dev`, and
  a `.dockerignore` that keeps `.env` out of the build context entirely — a
  secret copied into a layer is in the image forever, even if a later layer
  deletes it.
- **Has a real healthcheck**, hitting `/api/health` so orchestration sees
  database failure rather than just process liveness.
- **Handles SIGTERM.** `CMD ["node", "index.js"]` rather than `npm start`: npm
  sits between the signal and the process, and this server closes its Mongo
  client on the way down.
- **Waits for Mongo.** Compose gates the API on the database's healthcheck, not
  merely on the container existing — the API exits on a failed connect, so
  starting it early is a crash loop.

## Rate limiting

Token bucket per IP on mutating routes: capacity 80, refill 5/s. Far above a
real player (the client's save loop is debounced to about 1/s at its busiest)
and above the ops scripts, but a wall for a loop. `test-api.mjs` fires 140 rapid
writes and asserts some are refused — a limiter nobody has seen trip is a
limiter nobody has tested.

## Tests

| Suite | Covers |
|---|---|
| `test-api.mjs` | All 22 routes: existence, validation, response shape, WebSocket upgrade, body-size cap, rate limiting. 30 assertions. |
| `test-pvp.mjs` | Matchmaking, lockstep relay, desync referee, disconnect forfeits. |
| `test-clans.mjs` | Clan rules in depth — roles, permissions, membership. |
| `test-ladder.mjs` | Elo, league floors, client/server drift guard. |

`test-api.mjs` generates fresh actors per run from a timestamp. An earlier
version reused fixed addresses and passed exactly once — the second run found
Alice still in the clan she had founded and took nine assertions down with it.
A suite that only passes against an empty database is a suite that passes once.
