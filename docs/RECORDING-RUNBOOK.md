# Recording runbook: the 3-minute video on the live app

The click-by-click path, on https://mempire-monad.vercel.app (Monad testnet). Every step below ran end to end on 13 Oct (`app/e2e/live-smoke.mjs`); the timings are what it measured.

## Before you press record

- **Two browser windows, side by side.** Use separate profiles (or one normal and one incognito), so each is a fresh player:
  - **Window A** (left, desktop size, e.g. 1440×900): the player you show.
  - **Window B** (right, phone size, e.g. 390×844 in DevTools device mode): the opponent.
- **Passkey (optional, nicer).** On a device with a PRF-capable passkey (iPhone, Android or a recent Mac in Chrome or Safari), use **Create with passkey** in A. Anywhere else, use **Play as Guest**; it is the same flow without the biometric prompt.
- **Check before recording:**
  - https://relay-production-9c75.up.railway.app/api/health shows `"ok":true` and `"persistent":true`;
  - the landing page heartbeat strip is moving.
- **Sound on** for the battle sfx. Close other tabs that hit Monad's RPC (it rate-limits per IP).
- **Nothing to fund.** The relayer pays onboarding; each new player receives 0.4 MON and 10,000 test AUSD.

## The run (≈ 3:00)

| Time | Click / action | What appears | Caption line | Pause on |
|---|---|---|---|---|
| 0:00–0:15 | Open the app in A. Don't click yet | "Every coin is a fighter", and the **Monad testnet heartbeat**: blocks turning proposed → voted → final, with ms | "That strip is Monad, live: a block is voted in ~290 ms and final in ~575 ms." | The heartbeat: hold 3 s on a block turning green |
| 0:15–0:35 | A: **Play now → Create with passkey** (or **Play as Guest**) | The banner "Your deck is on chain · ~9 s"; the tour appears (tap **Skip**) | "One prompt. No seed phrase, no extension, no faucet. The deck is eight ERC-721s, minted for me." | The banner's seconds |
| 0:35–0:45 | B: same, **Play as Guest** | B's deck lands (7–11 s) | (off-camera prep; trim in the edit) | — |
| 0:45–0:55 | Both: Arena → stake currency **MON** → tier **$1** | The pot card "POT … escrowed on Monad" and the market buff/nerf panels (epoch, "on chain") | "A dollar stake, escrowed by the contract. Today's market buffs and nerfs the cards, written on chain by Chainlink CRE." | The **buffed / nerfed by the market** panels |
| 0:55–1:00 | A then B: **Rush · 30s** | Matched; both enter the battle | — | — |
| 1:00–1:45 | A: drag cards onto your half (left lane works well) | Card pills over the arena: **"$DOGE exec 935 · final 1599 ms"**; the top bar reads **ON MONAD · EXEC … · FINAL …**; "POT LIVE"; damage numbers; a tower falls in slow motion | "Every card I drop is a Monad transaction, executed and final while the unit walks the lane." | The exec/final pills (2 s), and the tower-fall slow-mo |
| 1:45–2:05 | Wait for the end | **POT SECURED**: pot, rake 10%, "You take"; "N state hashes committed · settled" | "The second claim settles the pot in the same transaction: 90% to the winner." | The money rows |
| 2:05–2:25 | A: **▶ Replay from the chain** (result screen) | The replay rebuilds the match from on-chain plays: **"✓ Verified against N on-chain checkpoints"** | "This is the match rebuilt from Monad and checked against the hashes both players posted." | The ✓ verified line |
| 2:25–2:45 | A: **Empire** tab → Monad network panel | Staking epoch and the proposer's validator (from `0x1000`); tap **Verify a passkey on Monad** → "✓ verified by Monad's P256 precompile · a tampered copy was refused" | "Monad's precompiles: native staking, and passkeys verified by the chain itself." | The ✓ passkey line |
| 2:45–3:00 | A: **Cards** tab (season pass), then the Empire leaderboards | The season pass progress (1 staked win); the leaderboards with this match | "Seasons, clans and leaderboards, all scored from the chain. That's Mempire." | End card: the live URL |

## Monad moments to hold on

1. **The heartbeat** (0:00): proposed → voted ~290 ms → final ~575 ms, measured live in the browser.
2. **The per-card pills** (1:00+): "exec ~0.9–1.4 s · final ~1.5–1.9 s" (browser to public RPC, round trip included).
3. **POT SECURED** (1:45): settlement in the same transaction as the second claim.
4. **✓ Verified against N on-chain checkpoints** (2:05).
5. **The P256 ✓** (2:25).

## If something hiccups

- **The deck banner doesn't appear within ~20 s.** Reload once: the account is kept, and onboarding is idempotent. Monad's public RPC can rate-limit; the app falls back to other RPCs automatically.
- **"Playing for the ladder only" or "NO STAKE" in the battle.** The stake didn't open: usually the opponent pressed Rush before their deck banner showed. Return to the Arena, wait for both banners, then queue again. (MON is safer than AUSD: Agora's faucet sometimes queues the AUSD.)
- **No opponent found.** Both windows must pick the same currency and tier.
- **The replay says "pending".** Settlement is still landing; wait 5 s and press Replay again.
- **The relay is down** (`/api/health` not ok). Stop: the coordinator or Claude redeploys it (`railway up` in `server/`).
- **The passkey check fails** on a device without ES256 passkeys: skip that shot; the staking panel is enough.

## What one run consumes

| Who pays | Amount | For |
|---|---|---|
| Relayer `0x91c8B2ccDd9f8f13065658e8E60E71916B0593aD` | ≈ 1.1 MON | 2 onboardings: the starter mint (~0.13 MON gas each) + the 0.4 MON drip each + the faucet call |
| Each player (from their own drip) | 0.01 MON stake + ~0.06 MON gas | createMatch/joinMatch; the 0.2 MON session float is swept back after the match |
| Winner / loser | +0.008 / −0.01 MON | the pot minus the 10% rake |
| AUSD | 0 | Each player receives 10,000 test AUSD; the MON stake doesn't use it |
| Deployer / paymaster | 0 | Not used in this path |

The relayer holds ~17.8 MON (7.8 above Monad's 10 MON reserve): about 7 recording takes before it needs a top-up. **No top-up is needed for one recording.**
