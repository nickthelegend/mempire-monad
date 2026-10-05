# Quality gate

Re-run with `./scripts/test-all.sh`, `npx oxlint` in `app/`, and
`slither . --filter-paths "lib/|test/|script/" --exclude-informational --exclude-optimization`
in `contracts/`.

## Suites (6 Oct, local fork stack)

| Suite | Result |
|---|---|
| contracts (forge) | 61 passed |
| simulation determinism | SIM OK |
| app typecheck (`tsc -b`) | clean |
| relay: auth / memstore / locker | 14 / 13 / 10 passed |
| relay: persistence (real MongoDB, restart) | 5 passed |
| relay: Kimi AI (fake Moonshot server, a test double) | 46 passed |
| relay: onboarding, on a throwaway fork | 36 passed |
| relay: settlement, on a throwaway fork | 12 passed |
| relay: Privy policy + honest 503s | 21 passed |
| game end to end, on a throwaway fork | 25 passed |
| CRE workflow (bun) | passed |
| Envio handlers (vitest) | 9 passed |
| Envio on the fork: `seed-local` + `verify-local` | 52 passed |

The chain suites fork Monad testnet on :8613 (chain 31338), deploy, run and
tear it down. They never touch the dev chain, and they use Agora's real AUSD
and faucet and live prices.

## Lint

`oxlint`: 0 errors. The warnings are React-compiler hints in the three.js
scene (`use-memo` with a non-inline factory, and mutation of a texture object
inside an effect). They are deliberate for per-frame performance and were left
as they are.

## Slither: triage

| Detector | Where | Verdict |
|---|---|---|
| reentrancy-eth | `MarketMeta.postFromPyth` | **Fixed.** The epoch is now claimed before any external call, so a re-entrant post fails `StaleEpoch`. |
| reentrancy-eth / -benign / -events | `MempireArena._settle`, `_void`, `_pay`, `createMatch` | False positive. Every entry point is `nonReentrant`, state is written before payouts, native payouts carry a 50k gas stipend, and a refused payout goes to `owed` for pull withdrawal. |
| arbitrary-send-eth | `MempireArena._pay`, `MarketMeta.postFromPyth` | By design. Payees are the match's two seats and the treasury; the refund goes to `msg.sender`. |
| divide-before-multiply | `_settle`, tie branch | Intended: `half = (pot − rake) / 2`, then the odd unit goes to the treasury. |
| weak-prng | `MempireCards.reveal`, `_rollTier` | Accepted. A chest commits to a future block at `open` and reveals from that block's hash, which no player can choose. A validator could grind it in principle; for a cosmetic-tier chest that risk is accepted and documented. |
| pyth-unchecked-confidence | `postFromPyth`, `_postPrice` | Accepted. Momentum is spot against EMA, clamped to ±15%. A card's mint price is a record, not a settlement price. |
| incorrect-equality | `holdsCards` | False positive: a state-enum comparison. |
| uninitialized-local | several | Intended zero defaults. |
| missing-zero-check | constructors and setters | Owner-only configuration, set once by the deploy script. |
| calls-loop | `postFromPyth`, `isLocked` | Bounded: at most the 36-coin roster, or 8 cards. |

## Secret scan

`git grep` over the tree and `git log -p --all` over history found no API keys,
PEM keys, Privy secrets, or non-public 64-hex keys. The only private keys in
the repo are anvil's published dev keys, used on local chains only. `keys/`,
which holds the fresh testnet deployer and relayer, is gitignored and has never
been committed.
