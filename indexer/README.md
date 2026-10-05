# Mempire indexer (Envio HyperIndex)

An [Envio HyperIndex](https://docs.envio.dev) indexer for Mempire on **Monad testnet (chain 10143)**,
which is a native HyperSync chain (`https://10143.hypersync.xyz`). It turns the three Mempire
contracts into a GraphQL API the app uses for leaderboards, match history, the live play feed and
fighter win rates.

- HyperIndex **v3** (`envio@3.13.0`): `chains:` config, `indexer.onEvent` handlers, `createTestIndexer` tests
- `config.yaml` lists the contracts and events, `schema.graphql` holds the entity model, and `src/handlers/*.ts` holds the handlers
- `test/mempire.test.ts` holds the handler tests (simulated events, no network or Docker)
- `scripts/sync-addresses.mjs` updates `config.yaml` after a deploy
- `scripts/query.mjs` holds the app's queries and a runner that tries them against an endpoint

## What is indexed

| Contract | Events | What they drive |
|---|---|---|
| `MempireCards` (ERC-721 fighters) | `CoinRegistered`, `CoinActive`, `CardMinted`, `CardMerged`, `Transfer`, `ChestGranted`, `ChestForfeited`, `ChestUnlocking`, `ChestSkipped`, `ChestOpening`, `ChestOpened` | roster, every card with its owner/level/history, merges, chest lifecycle |
| `MempireArena` (escrowed 1v1) | `MatchCreated`, `MatchJoined`, `MatchCancelled`, `Played`, `Checkpoint`, `Claimed`, `MatchSettled`, `MatchVoided`, `WinRewarded`, `PayoutHeld` | matches, per-seat results and P&L, the on-chain play log, claims, payouts |
| `MarketMeta` (Chainlink CRE) | `MetaPosted` | per-epoch ±15% modifier per fighter, current modifier on each coin |

## Entity model

```
Player ─┬─< Card >── Coin ─< CoinModifier >── MarketEpoch
        ├─< MatchSeat >── Match ─┬─< Play  (coin + card resolved from the seat's deck)
        │                        ├─< Checkpoint
        │                        └─< Claim
        └─< Chest ─< Card (drops)
Card ─< Merge            DailyStats (per UTC day)      Totals (id "global")
```

| Entity | Notes |
|---|---|
| `Player` | matches / wins / losses / ties / voids, `netMon` / `netAusd` (payout − stake, base units), wagered, cards owned, highest level, merges, chests, rewarded wins, `lastActive` |
| `Card` | owner, coin, level, archetype, source (Mint / MintMempire / Starter / Chest), Pyth mint price + expo, chest it dropped from, `burned`, `mergedInto`, `mergesAbsorbed`, its own win/loss record |
| `Coin` | ticker, name and kind (crypto / meme / stock, joined from `shared/roster.json` by Pyth feed id), archetype, supply, merges, **deck appearances, wins / losses / ties when fielded, `winRateBps`**, results split by buffed/nerfed modifier, `timesPlayed`, current modifier |
| `Match` | both players and session keys, tier, currency, stake, deck hashes, powers, meta epoch, state, outcome, winner, plays per seat, checkpoints, both claims, pot / rake / payouts, chest tier, timestamps, `durationSeconds`, `byTimeout`, `disputed` |
| `MatchSeat` | one row per (match, seat): the player's side, deck `cardIds` → `coinIds`, result, payout, `net`. This is the player-history entity |
| `Play` | match, seat, player, tick, cardIndex, **card and coin resolved from the seat's deck**, x, y, per-seat sequence, block, log index, timestamp, tx hash. This drives the live feed |
| `Chest` | tier, bought, state machine (Idle → Unlocking → Revealing → Opened), the match that paid it, skip fee, reveal block, re-commits, seed, drops |
| `MarketEpoch` / `CoinModifier` | each CRE report, its top and bottom movers, and the matches that snapshotted it |
| `DailyStats` | matches created / started / settled / voided / cancelled, ties, volume and rake per currency, plays, checkpoints, mints, merges, chests, rewards, unique and new players |
| `Merge`, `Checkpoint`, `Claim`, `HeldPayout` | event logs |
| `Totals` | protocol-wide counters (single row `id: "global"`) |
| `PlayerDay`, `SettlementTx` | internal join rows: unique-players-per-day, and settlement tx → match (so the `ChestGranted` / `ChestForfeited` that the arena fires later in the same tx find their match) |

### The joins and the edge cases

- **Coin win rates are derived.** `MatchCreated` and `MatchJoined` carry each deck's `cardIds`. Every card is resolved to its coin and stored on the `MatchSeat`. At settlement each coin in the winning deck gets a win and each coin in the losing deck gets a loss. A tie gives every coin on both sides a tie. The modifier the coin carried in the epoch the match snapshotted at join decides whether the result is also counted as buffed or nerfed.
- **Void and disputed matches move no money.** A `MatchVoided` (disputed claims, or no claims by the deadline) marks both seats `Void` with `payout = stake` and `net = 0`. It changes no player's `net*` or `wagered*`, no coin results, and no volume or rake. `MatchCancelled` is handled the same way.
- **Ties split.** Each seat is paid `(pot − rake) / 2`; the contract sends the odd unit to the rake.
- **Walkovers.** A settlement through `claimTimeout` (`byTimeout = true`) still pays the pot, but only the winner's `winsByTimeout` marks it.
- **Mints and burns.** A `Transfer` from the zero address is a mint, which the `CardMinted` in the next log creates. A `Transfer` to the zero address is a burn, and the following `CardMerged` links the burned card to the card it was merged into.
- **Market resets.** A coin left out of an epoch's `MetaPosted` reads 0 on chain for that epoch, so its `currentModifierBps` resets to 0.
- **Addresses** are stored lowercase (`address_format: lowercase`). Query with `address.toLowerCase()`.
- **Amounts** are `BigInt` in base units: MON in wei, AUSD in 6-decimal units, $MEMPIRE in wei.

## Queries the app uses

Envio exposes a Hasura GraphQL API. Entity names are used as written, relations can be filtered as `<field>_id`, and single rows come from `<Entity>_by_pk`. All of these queries are in `scripts/query.mjs`.

**Leaderboard by wins**

```graphql
query LeaderboardByWins($limit: Int = 20) {
  Player(where: { matches: { _gt: 0 } }, order_by: [{ wins: desc }, { netMon: desc }], limit: $limit) {
    id wins losses ties voids matches netMon netAusd highestLevel cardsOwned lastActive
  }
}
```

**Leaderboard by net MON**

```graphql
query LeaderboardByNetMon($limit: Int = 20) {
  Player(where: { matches: { _gt: 0 } }, order_by: [{ netMon: desc }, { wins: desc }], limit: $limit) {
    id netMon wageredMon wins losses ties matches
  }
}
```

**A player's match history** (`$player` lowercase)

```graphql
query PlayerHistory($player: String!, $limit: Int = 20) {
  Player_by_pk(id: $player) {
    id matches wins losses ties voids netMon netAusd cardsOwned highestLevel chestsOpened rewardedWins lastActive
  }
  MatchSeat(where: { player_id: { _eq: $player } }, order_by: { createdAt: desc }, limit: $limit) {
    seat result currency stake payout net power plays coinIds
    opponent { id }
    match {
      id state outcome tier byTimeout disputed voidReason pot rake metaEpoch
      playCount createdAt endedAt durationSeconds endedTxHash
    }
  }
}
```

**Latest 50 plays across all matches** (for live updates, change `query` to `subscription`)

```graphql
query LatestPlays($limit: Int = 50) {
  Play(order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: $limit) {
    id match_id seat player_id tick cardIndex x y seq blockNumber timestamp txHash
    coin { id ticker kind archetypeName currentModifierBps }
    card { id level }
  }
}
```

**Coin win rates with the current market modifier**

```graphql
query CoinWinRates {
  Coin(where: { registered: { _eq: true } }, order_by: [{ winRateBps: desc }, { fielded: desc }]) {
    id ticker name kind archetypeName fielded wins losses ties winRateBps deckAppearances
    timesPlayed liveSupply maxLevel currentModifierBps modifierEpoch
    winsBuffed lossesBuffed winsNerfed lossesNerfed
  }
  MarketEpoch(order_by: { epoch: desc }, limit: 1) {
    epoch postedAt maxBps minBps topCoin { ticker } bottomCoin { ticker }
  }
}
```

**Overview** (landing page totals and a 14-day chart)

```graphql
query Overview($days: Int = 14) {
  Totals_by_pk(id: "global") {
    players coins matches matchesSettled matchesVoided plays cardsMinted merges chestsOpened volumeMon volumeAusd currentEpoch
  }
  DailyStats(order_by: { dayStart: desc }, limit: $days) {
    id matchesStarted matchesSettled matchesVoided volumeMon volumeAusd plays cardsMinted merges uniquePlayers newPlayers
  }
}
```

To try the queries against an endpoint:

```bash
node scripts/query.mjs <graphql-url>                       # every query
node scripts/query.mjs <graphql-url> latestPlays
node scripts/query.mjs <graphql-url> playerHistory --player 0xYourAddress
```

## After deploying the contracts

`contracts/script/Deploy.s.sol` writes `shared/deployments/10143.json`. After that file exists, run:

```bash
cd indexer
pnpm sync      # copies ABIs + roster, writes cards/arena/marketMeta addresses and start_block into config.yaml
pnpm codegen
pnpm test
```

`node scripts/sync-addresses.mjs --check` exits non-zero while `config.yaml` still has its
`# TODO` placeholder addresses. The script also refreshes `abis/` and `src/roster.generated.ts`
because Envio Cloud builds only the `indexer/` directory, so the indexer cannot import anything from outside it.

## Run the tests

```bash
cd indexer
pnpm install
pnpm codegen   # generates .envio/types.d.ts from config.yaml + schema.graphql
pnpm typecheck
pnpm test      # vitest + createTestIndexer: simulated events through the real handlers
```

## Run locally against Monad testnet

Running locally needs Docker for Postgres and Hasura, plus an Envio API token for HyperSync (create one at https://envio.dev/app/api-tokens).

```bash
cd indexer
cp .env.example .env          # set ENVIO_API_TOKEN
pnpm dev                      # codegen, then indexer + Postgres + Hasura
# GraphQL: http://localhost:8080/v1/graphql   (console password: testing)
pnpm exec envio stop          # tear down
```

## Deploy to Envio Cloud

1. Push this repo to GitHub (public). Run `pnpm sync` first so `config.yaml` has the real testnet addresses and start block.
2. Sign in at https://envio.dev/app/login with GitHub, then pick your personal account or an organisation.
3. Install the **Envio Deployments** GitHub App and give it access to the repo.
4. Click **Add Indexer** and select the repo. Set:
   - **Root directory:** `indexer`
   - **Config file:** `config.yaml`
   - **Deployment branch:** for example `envio` or `main`
5. Push to the deployment branch. Each push builds and re-indexes from `start_block`, and the old version keeps serving until the new one has synced.
6. Copy the deployment's GraphQL endpoint from the dashboard (or run `npx envio-cloud deployment endpoint <indexer> <commit>`) into the app's config.

Envio Cloud's requirements are: `package.json` in the root directory with `envio` pinned (it is: `3.13.0`), pnpm 10 compatible, Node 24 recommended, and no imports from outside `indexer/`.

The free development plan has a soft limit of **100,000 processed events** per deployment. Each match can log up to 400 `Played` events, so a busy testnet demo can reach that limit. Watch it in the dashboard, or upgrade the plan for the judging window.
