# How Mempire uses Chainlink CRE: the market is the meta

*Mempire · Monad Metropolis, Track 03 · live at https://mempire-monad.vercel.app*

Mempire is a real-time 1v1 card battler on Monad.
- Every fighter is a real asset: BTC, ETH, memecoins and tokenised stocks.
- Two players stake, play a three-minute lane battle, and every card they drop is a Monad transaction.
- The contract pays the winner.

The hook is that **the market is the meta**: today's price moves make each fighter a little stronger or weaker. A Chainlink CRE workflow decides those numbers and writes them on chain.

## The problem CRE solves: a balance patch nobody can rig

The meta changes how strong a card is, in matches where people stake money. That makes it a fairness problem as well as a game-design one:

- **We can't write it ourselves.** If the team's server posts the buffs, the team can tilt the game toward the cards it holds.
- **A single price API isn't enough.** One provider can lag, cache, or be wrong for a minute.
- **Both players must see the same numbers.** The meta has to be on chain before a match starts.

So we needed independent fetching, agreement across nodes, and a verifiable write to a contract the game reads. That is CRE's shape.

## How it works

### 1. The workflow (TypeScript, `cre/market-meta/`)

A cron trigger runs every epoch, a ten-minute window.
- Each node fetches 24h price changes: CoinGecko for crypto, Pyth Hermes for stocks.
- Each change is mapped to a bounded modifier, at most ±15% (`MAX_BPS = 1500`).
- The nodes agree on the result **coin by coin**.

```ts
// cre/market-meta/main.ts — consensus per fighter, not on the whole array
const medianPerCoin = (coins: readonly RosterCoin[], extra: string[] = []) =>
	ConsensusAggregationByFields<BpsByKey>(
		Object.fromEntries([...coins.map((c) => [coinKey(c.coinId), median]), ...extra.map((k) => [k, median])]),
	)
```

We chose a per-field median over identical consensus on the whole array. Price answers drift between nodes (edge caches, a trade landing between two requests), so a byte-identical array would often miss quorum. A per-coin median tolerates lagging nodes and still lands on an honest value.

The workflow then reads `currentEpoch` from the contract. It skips the write if the epoch is stale, and writes the signed report otherwise:

```ts
const signed = runtime.report(prepareReportRequest(encoded)).result()
const reply = evm.writeReport(runtime, { receiver: marketMeta, report: signed, gasConfig: { gasLimit: cfg.gasLimit } }).result()
```

### 2. The receiver (`contracts/src/MarketMeta.sol`)

```solidity
function onReport(bytes calldata metadata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert NotForwarder();
    ...
    (uint64 epoch, uint16[] memory coinIds, int16[] memory bps) = abi.decode(report, (uint64, uint16[], int16[]));
    if (epoch <= currentEpoch) revert StaleEpoch();
    for (uint256 i; i < coinIds.length; ++i) {
        if (bps[i] > MAX_BPS || bps[i] < -MAX_BPS) revert OutOfBounds();
        modifierBps[epoch][coinIds[i]] = bps[i];
    }
    ...
    emit MetaPosted(epoch, coinIds, bps);
}
```

- **Only the forwarder may call it.** It can also be pinned to the workflow owner.
- **Epochs only move forward**, and every value is clamped again on chain.

### 3. The game

When two players are matched, the relay reads `currentEpoch`. **Each match locks that epoch:**
- the arena records it in the match (`metaEpoch`);
- both clients read the same `modifierBps` and build the same deterministic simulation from them;
- a buffed fighter hits harder and a nerfed one is weaker, by at most 15%.

In the app, the side boards and the phone strip show who is buffed, who is nerfed, and how old the meta is ("meta from 2 h ago · on chain").

## Engineering notes

- **Two writers share one epoch clock.**
  - CRE is the primary writer.
  - A permissionless `postFromPyth` path lets anyone post a meta derived from Pyth prices.
  - `epochSource` records which writer set each epoch, and the workflow skips epochs that were already written.
- **Zod URL validation and the CRE runtime.** Config URLs were validated with zod's `.url()`, which needs the `URL` global. The CRE WASM runtime doesn't have it, so every simulation failed validation. We replaced it with a pattern check.
- **Tests:** 33 (`bun test` in `cre/`), covering the roster, the curve, the encoding and the aggregation.

## The value it brought

- **A meta nobody on the team controls.** The numbers that change staked outcomes come from independent fetches with on-chain enforcement, not from our server.
- **A reason to check the market every day.** The arena changes when prices move. It's the core of the "every coin is a fighter" pitch, and it gives communities something to share: "$BOME −5.7% today".
- **Fairness you can check.** Each match's epoch is on chain, so anyone can verify the exact numbers a match was played with.

## Live proof (Monad testnet)

- **The CRE write:** `MetaPosted` for epoch **2986491**, 36 coins.
  - tx [`0x26b6bc97…b219`](https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219);
  - read live: https://mempire-monad.vercel.app/proof.html?tx=CRE~0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219.
- **MarketMeta:** [`0x17Ca9e2102d2B38f3676fEc6B5EA6c927753d148`](https://testnet.monadvision.com/address/0x17Ca9e2102d2B38f3676fEc6B5EA6c927753d148), verified on Sourcify.
- **A match played on that meta:** live match #1 locked `metaEpoch = 2986491`, and its pot was settled in [`0x8911e19b…7919`](https://testnet.monadvision.com/tx/0x8911e19bb5dad725d3681b94d919fcf290b4ba5c03e23669c829220baadf7919).

**Honest limits:**
- The write was sent with `cre workflow simulate --broadcast`, through the CRE simulation forwarder (`0xB9F7…D192`). The workflow is **not deployed to a DON** yet, so consensus ran in the simulator.
- The meta updates when the workflow runs, not on its own every ten minutes. The app shows its age instead of pretending it's current.
