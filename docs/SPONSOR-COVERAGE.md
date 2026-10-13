# Sponsor coverage

Updated 13 Oct 2026, after the Monad testnet deploy. "Working" means it runs on Monad testnet today, with a transaction or a read anyone can check. Contracts: `shared/deployments/10143.json`.

| Sponsor | Status | Proof |
|---|---|---|
| **Chainlink CRE** | **Working** | `cre workflow simulate --broadcast` wrote the market meta (36 coins, epoch 2986491) to `MarketMeta`: [`0x26b6bc97…b219`](https://testnet.monadvision.com/tx/0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219). Live match #1 ran on that epoch. |
| **Pyth** | **Working** | A BTC card minted with a live Hermes update verified on chain by Pyth: [`0x313623fd…886a`](https://testnet.monadvision.com/tx/0x313623fdcef0eb2423ce822aa34812f59efe0df0a06671425f84551a1968886a). The shared key covers 7 of 36 feeds (BTC, ETH, SOL, BNB, XRP, DOGE, TSLA); the rest say "no live price" rather than fail. |
| **Agora AUSD** | **Working** | Onboarding pulls Agora's real faucet: both live-smoke guests hold 10,000 AUSD (`balanceOf` on `0xa901…22dC` for `0xf00f…682D` and `0x2641…4BCD`). AUSD staking uses its EIP-2612 permit; it is proven on the fork (`test-e2e.mjs`). The live match staked MON, because the faucet sometimes queues. |
| **Mera (passkeys)** | **Working in the live app** | "Create with passkey" derives the account from WebAuthn PRF; verified in Chrome with a virtual authenticator. The in-app P-256 check runs on Monad's `0x0100` precompile (live `eth_call`). |
| **Privy** | **Set up; one dashboard step left** | Signer key quorum registered and the match policy (`play`/`checkpoint`/`claim`, value 0, chain 10143) created on the shared app via the API. Email sign-in needs the user to allow the origins and turn on gas sponsorship in the Privy dashboard. |
| **Envio** | **Built; hosting is a dashboard step** | Handlers 9/9 against the testnet start block; `verify-local` 52/52 on the fork. Envio Cloud deploy (repo connect) is in `doitlater`. |
| Kimi (Moonshot) | Off by the user's rule | "Kimi · not configured"; the classic bot opponent plays instead. |

## Monad tech, live on testnet

| | Proof |
|---|---|
| Commit states (`monadNewHeads`) | Live app heartbeat: voted ~290 ms, final ~575 ms, measured in the browser |
| Every card play is a transaction; settlement in one block | Match #1: a play [`0x9f648b9e…3258`](https://testnet.monadvision.com/tx/0x9f648b9ed4fecd5de8c2b39c729ea931d1d40f1dd8ae12e17e63c79f23153258) and the settling claim [`0xa89f61a6…a492`](https://testnet.monadvision.com/tx/0xa89f61a661c923543975062b060af5d0df2e7ebd6af0dba1a61f1901a6f5a492); per-play receipts executed 0.9–1.4 s / final 1.5–1.9 s (`docs/LIVE-SMOKE.json`) |
| EIP-7702 + ERC-4337 v0.8 paymaster (gasless) | Chest open with the 7702 authorization [`0xb0cec249…cc59`](https://testnet.monadvision.com/tx/0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59) and reveal [`0x342a7b31…3c37`](https://testnet.monadvision.com/tx/0x342a7b31ee93e6ef99c96509003d2e18de1ba51b4262fcea993c820336103c37); player MON unchanged (`docs/LIVE-GASLESS.json`) |
| P256VERIFY `0x0100` | `PasskeyRegistry` deployed; in-app passkey check by live `eth_call` (12,773 gas vs 353,980 in Solidity) |
| Staking precompile `0x1000` via Multicall3 | Live read in Empire: epoch and the block proposer's validator |
| Reserve balance (10 MON) | Relayer drips stop above the reserve (`test-reserve` 8/8); the drip is 0.4 MON so a first staked match always fits |
| Delayed execution | Learned live: a freshly funded wallet must wait a few blocks before consensus sees its balance (handled in `live-gasless.mjs`) |
