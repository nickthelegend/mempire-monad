# Mempire on Monad: the Monad-native integrations

Each integration lists where it runs, so nothing claims more than it shows:
- **live-read**: read-only calls or subscriptions against Monad testnet, real today;
- **fork**: on the local anvil fork of Monad testnet;
- **awaiting testnet go**: the code ships, but real numbers need the testnet deploy, which is on hold until MON is funded.

| # | Integration | Runs | Code | Evidence |
|---|---|---|---|---|
| 1 | **Live block pipeline.** `monadNewHeads` over the public WebSocket; each block shown Proposed → Voted → Finalized → Verified with the ms measured in the browser. A reducer handles a skipped Voted, competing proposals dropped on finalize, untimed mid-flight joins, and forward-only states. | **live-read** | [`app/src/lib/monadHeads.ts`](../app/src/lib/monadHeads.ts), [`components/MonadPipeline.tsx`](../app/src/components/MonadPipeline.tsx) | `scripts/monad-heads-test.ts` 13/13. In Chrome: voted ~290 ms, final ~575 ms ([w1 screens](screens/wave/)) |
| 2 | **Two-timer receipts.** "executed X ms" (receipt; `eth_sendRawTransactionSync` on Monad) and "final Y ms" (checked against the finalized block's hash). | **fork** (labelled "local fork · N ms"); testnet timings **awaiting testnet go** | [`app/src/chain/landing.ts`](../app/src/chain/landing.ts), [`state/playLog.ts`](../app/src/state/playLog.ts), [`components/PlayTicker.tsx`](../app/src/components/PlayTicker.tsx) | Per-play HUD pills in Chrome ([w2 screens](screens/wave/)) |
| 3 | **Transaction status.** `txpool_statusByHash` before inclusion (Monad's `eth_getTransactionByHash` omits pending transactions). | Monad networks only; **awaiting testnet go** | `chain/landing.ts` | — |
| 4 | **Passkeys on chain.** Mera passkey accounts (PRF → EOA), plus P256VERIFY at `0x0100`: `PasskeyRegistry` binds and verifies WebAuthn assertions with `P256.verifyNative`, and the app has a passkey signature verified by Monad's precompile. | Mera **fork + browser**; `0x0100` **live-read** (`eth_call`); the contract is **tested** (Osaka EVM) and **deployed with the testnet deploy** | [`contracts/src/PasskeyRegistry.sol`](../contracts/src/PasskeyRegistry.sol), [`app/src/chain/monadNetwork.ts`](../app/src/chain/monadNetwork.ts), [`components/MonadNetworkPanel.tsx`](../app/src/components/MonadNetworkPanel.tsx) | forge 9/9 (`FOUNDRY_PROFILE=osaka`). In Chrome: "✓ verified by Monad's P256 precompile · a tampered copy was refused" ([m screens](screens/wave/)) |
| 5 | **Native staking.** The `0x1000` precompile: epoch, delay period, and the block proposer's validator stake and commission. | **live-read** | `chain/monadNetwork.ts` (ABI from `@monad-crypto/viem`) | In Chrome: epoch 1382, proposer and stake shown live |
| 6 | **Gas correctness.** See below. | built | see below | `test-reserve.mjs` 8/8 |
| 7 | **x402 / MPP payments.** | **not applicable** | — | Mempire's money is the staked pot, escrowed by `MempireArena` in MON or AUSD (EIP-2612 permit). Nothing is sold per call. Routing stakes through a facilitator would add a custodian between two players and their pot. |
| 8 | **Canonical contracts.** Multicall3 `0xcA11…CA11` for batched reads (it carries the staking reads, because `aggregate3` uses CALL, which `0x1000` requires); Agora's AUSD; Sourcify verification on MonadVision in the deploy script. | **live-read** (Multicall3) / deploy | `chain/monadNetwork.ts`, `scripts/deploy-testnet.sh` | WMON and Permit2 are **not applicable**: stakes are native MON or AUSD, and AUSD has native EIP-2612 permits. |

## Gas on Monad (item 6)

- **Charged on the gas limit, not gas used.**
  - Every transaction the app sends has an explicit limit: the estimate × 1.15, from `simulateContract` first. If the simulation reverts, nothing is sent, so a wallet can never fall back to a 30M limit.
  - Card plays (~45k) and checkpoints are sized the same way.
  - The session float is priced at the chain's own gas price.
- **Reserve balance (10 MON, MIP-4).**
  - The onboarding relayer sends MON drips again and again, so the one-off "emptying" exception never applies.
  - On a Monad network it keeps gas + drip + 10 MON before taking a claim, and re-checks at send time, so it never sends a drip that would revert and still burn gas.
  - The rule is a pure function, `relayerNeeds` / `dripIsReserveSafe` in `server/onboard.js`.
  - The arena is a contract, so the EOA reserve rule doesn't apply to its payouts. A refused payout goes to `owed` for pull withdrawal.
- **128 KB contracts.** Not needed: the largest contract (`MempireCards`) is well under the Ethereum limit.
- **MIP-8 page storage.**
  - Per-match state is one `Match` struct under one mapping key, so a match's seats, stakes, claims and play counters share storage pages: one cold page load, then warm writes.
  - Each card is one packed struct (coinId, level, archetype, lockedBy, mint price).
  - Play logs are events, not storage. No global counter is written by every play.
- **300 ms blocks, ~600 ms finality.** Every place the app, docs or video script spoke of 400 ms now says 300 ms / ~600 ms.

## Not built, and why

- **EIP-7702 + a 4337 paymaster** for gasless onboarding needs hosted bundlers on testnet and a delegated EOA keeping 10 MON. It is next in the roadmap and awaits testnet.
- **Execution Events SDK** needs a Monad full node on the same Linux host, so it isn't usable from a web app.
