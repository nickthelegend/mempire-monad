# Seeded demo activity, 13 Oct 2026

**This is demo activity by the Mempire team, not organic users.** Judges marked the live app down for looking empty (one match, no clans), so the team seeded it on Monad testnet:
- 8 fresh guest wallets, onboarded by the relayer exactly as any new player is;
- real games played through the hosted client (`app/e2e/seed-matches.mjs`);
- clans, a clan war and gasless chests through the hosted relay (`server/seed-social.mjs`).

The guest keys are in the gitignored `keys/seed-13oct.json`.

## Wallets (8, all onboarded by the relayer)

[`0x22CB…d824`](https://testnet.monadvision.com/address/0x22CB339C63dF8756dA687d971fA71F7c14DCd824) · [`0x2f0A…0BE1`](https://testnet.monadvision.com/address/0x2f0A522282CdddFF6e95c06FcB1bcb7b555e0BE1) · [`0x5ddd…9B24`](https://testnet.monadvision.com/address/0x5ddda368e4E650486D3912bCaDD385adE73D9B24) · [`0xef01…A193`](https://testnet.monadvision.com/address/0xef01ee6D1Ab93e6B1b1B03181CBA2FFE19CbA193) · [`0xA071…d9fA`](https://testnet.monadvision.com/address/0xA071235b10393Bb30566c324049b5b04b3fdd9fA) · [`0x0d8c…c723`](https://testnet.monadvision.com/address/0x0d8c889cf648D4960CcA1865dD8fd0f93DcCc723) · [`0x207f…E139`](https://testnet.monadvision.com/address/0x207f94F9ef5C46A42B72d05D97bcaF1122a9E139) · [`0x56D5…B748`](https://testnet.monadvision.com/address/0x56D5d3Bc19f10155f5F07F585C5d575847D7B748)

## Staked matches (MON, $1 tier = 0.01 MON)

Each match was played in the game client by both seats (real card plays) and settled by the second claim. Replay records exist for all of them.

| Arena match | Settlement tx (`MatchSettled`) |
|---|---|
| #2 | [`0xdcb6df32…0612`](https://testnet.monadvision.com/tx/0xdcb6df3254bb57246c231ad1a56a3a3ecd341a715a4eb94ab316141523120612) |
| #3 | [`0xe448d0e5…2ac8`](https://testnet.monadvision.com/tx/0xe448d0e56de6a4d0238bdd3bfda7596fdb7dd4737e477f5303f879f4c4542ac8) |
| #4 | [`0x769e4060…175a`](https://testnet.monadvision.com/tx/0x769e40604fa465d23fbde550d4ab4a227c27460822fd0049bd39c9e1c34d175a) |
| #5 | [`0x6875961b…febe`](https://testnet.monadvision.com/tx/0x6875961bad5b75b685a62150ea1988e7739a2eadbeca1f1c37953c5df882febe) |
| #6 | [`0xe730ab0f…c338`](https://testnet.monadvision.com/tx/0xe730ab0f0e35317ee0058b2322b7e251644030cd938eb21c32ad8271844dc338) |
| #7 | [`0x02f4ac21…5820`](https://testnet.monadvision.com/tx/0x02f4ac21b1dab04c384081a5e48ff3b7999f60a55bb1165d003afc6857905820) |

- #8 and #9 were opened, but the second seat's stake didn't go through. Their creators cancelled them and got the stake back: [`0xdc971297…bfa8`](https://testnet.monadvision.com/tx/0xdc9712979fd51e97f9de6f925691a0f976bcebc8844a20905447db6ae86ebfa8) and [`0x8574ea2b…bd0b`](https://testnet.monadvision.com/tx/0x8574ea2b777239e2f16b64896b22a2a7adf898ade4078ff8edfebd7efe79bd0b).
- Earlier: match #1, from the live smoke test.

## Clans (charter paid on chain: 250 $MEMPIRE to the treasury)

| Clan | Tag | Founder | Charter tx | Members joined |
|---|---|---|---|---|
| Diamond Hands | `XB6CD3` | [`0x22CB…d824`](https://testnet.monadvision.com/address/0x22CB339C63dF8756dA687d971fA71F7c14DCd824) | [`0xb530925b…cabe`](https://testnet.monadvision.com/tx/0xb530925bc9c798bb02c06a3522ad6b08ff3c00dae72e76713cbf3bab69a2cabe) | 2 |
| Bridge Burners | `4VM7ZR` | [`0x5ddd…9B24`](https://testnet.monadvision.com/address/0x5ddda368e4E650486D3912bCaDD385adE73D9B24) | [`0x4dbd6590…12ae`](https://testnet.monadvision.com/tx/0x4dbd6590a3150ffbb14d858da653905b07788936e510946874c47de259cd12ae) | 2 |
| Candle Knights | `UUM5GE` | [`0xA071…d9fA`](https://testnet.monadvision.com/address/0xA071235b10393Bb30566c324049b5b04b3fdd9fA) | [`0x91c0c9ac…b07e`](https://testnet.monadvision.com/tx/0x91c0c9acb9e524239828c2f8f1c76a17a395415219d0db3aa82cf3cd2a08b07e) | 1 |

**Clan war:** Diamond Hands vs Bridge Burners, a 2-clan bracket (`war-mv6vk8id`), status running. It is scored only by staked wins the relay verifies on chain.

## Gasless chests (EIP-7702 + the paymaster; the player's MON unchanged)

| Player | Chest | Tx (startUnlock as a user operation) |
|---|---|---|
| [`0x22CB…d824`](https://testnet.monadvision.com/address/0x22CB339C63dF8756dA687d971fA71F7c14DCd824) | #5 | [`0x957eefa6…0966`](https://testnet.monadvision.com/tx/0x957eefa6ed1c1af33d7a985cefd1966b42711821fa60f79933403cf122880966) |
| [`0x2f0A…0BE1`](https://testnet.monadvision.com/address/0x2f0A522282CdddFF6e95c06FcB1bcb7b555e0BE1) | #6 | [`0xb98fad27…5b28`](https://testnet.monadvision.com/tx/0xb98fad27dd98ca3ebc64e5f27b5d58899f67e36631f344c65dcc1462c8b95b28) |

## Cost

- Relayer: about 4.5 MON (8 onboardings: starter mint + 0.4 MON drip each).
- Deployer: about 0.01 MON (3 $MEMPIRE transfers for the charters).
- Paymaster deposit: about 0.05 MON (2 gasless operations).
- Total: about 4.6 MON, within the 12 MON budget.
