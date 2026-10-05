/**
 * Devnet starter kit: a little SOL and eight coins, once per address.
 *
 * # Why this exists
 *
 * "Your bags are your army" is the premise, and a wallet that has just arrived
 * has no bags. `mint_card` requires holding the coin, so without this a new
 * player cannot mint a single fighter, cannot field a legal deck, and can
 * therefore never reach a staked match. Every screen worked and the game was
 * unreachable.
 *
 * # What it can and cannot do
 *
 * It signs with `FAUCET_SECRET`, a key whose only power is spending what it
 * holds. Deliberately NOT the admin key: that one is the program's upgrade
 * authority, and a web server is the wrong place for it. Losing this key costs
 * a refill and nothing else.
 *
 * # Abuse
 *
 * Devnet tokens are worth nothing, so the threat is not theft but drain — one
 * script emptying the faucet so nobody else can start. Three guards: an
 * ed25519 signature proving the caller controls the address, one claim per
 * address ever (recorded in Mongo), and a per-IP rate limit. A determined
 * attacker with many keypairs can still drain it; the answer to that is
 * `setup-faucet.ts` refilling, not a harder puzzle for real players.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { requireWallet } from './auth.js';
import { recordEvent } from './telemetry.js';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';

/*
 * A faucet is a devnet thing by definition. If this relay is ever pointed at
 * mainnet (SOLANA_RPC set to a mainnet endpoint), the faucet must refuse
 * outright rather than drip whatever real SOL its key happens to hold — the
 * key is a hot wallet in an env var, and "free SOL endpoint on mainnet" is a
 * drain waiting for a scanner to find it.
 */
const IS_MAINNET_RPC = /mainnet/i.test(RPC);

/** Enough for eight mint fees (0.02 each), a 0.05 stake, rent and signatures. */
const DRIP_SOL = 0.35;
/** Whole tokens of each starter coin. One is enough to mint; more is friendlier. */
const DRIP_TOKENS = 25;
/** How many distinct coins a new player is handed. A legal deck is eight. */
const STARTER_COINS = 8;

/**
 * The $MEMPIRE a new player starts with.
 *
 * $MEMPIRE is now the game's only currency — Crowns are gone — so a player
 * who arrives with none of it cannot mint, upgrade, or skip anything. This is
 * the grant that used to be 120 Crowns, denominated in the token the game is
 * actually named after and readable on any explorer.
 *
 * Enough for a full deck of mints plus a first upgrade or two, and no more:
 * the AMM is right there for anyone who wants more than the game hands out.
 */
const DRIP_MEMPIRE = 2000;
const MEMPIRE_MINT = new PublicKey(
  process.env.MEMPIRE_MINT ?? 'AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8',
);
const MEMPIRE_DECIMALS = 6;

function faucetKeypair() {
  const secret = process.env.FAUCET_SECRET;
  if (!secret) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    return null;
  }
}

export function registerFaucetRoutes(app, db, coins, gate) {
  // The GET below spends a shared RPC quota, so it counts reads.
  const readGate = gate ?? ((_req, _res, next) => next());
  if (IS_MAINNET_RPC) {
    // Skip registration, don't crash the relay: everything else it does —
    // matchmaking, clans, ladder — is cluster-agnostic and must keep running.
    // The routes simply not existing (404) is the correct mainnet answer.
    console.warn('faucet routes not registered: relay is configured for mainnet');
    return;
  }
  const kp = faucetKeypair();
  const conn = new Connection(RPC, 'confirmed');
  const claims = db ? db.collection('faucet_claims') : null;

  // The first eight coins in the registry are the ones the default deck uses,
  // so a claimant can mint a legal deck immediately rather than shopping for
  // which of sixty-six they happen to have been given.
  const starters = coins.slice(0, STARTER_COINS);

  /*
   * The faucet's balance, at most once every twenty seconds.
   *
   * This called `getBalance` on every request, unauthenticated and unlimited —
   * the shared limiter exempts GETs unless asked otherwise. Each hit spent one
   * request from the relay's RPC quota, and that quota is the same one
   * `chain-verify` uses to establish who was paid what for a settled match. So
   * an anonymous loop against a status endpoint could get the relay's egress
   * IP throttled and take money verification down with it. The balance moves
   * only when somebody claims; a few seconds of staleness costs nothing.
   */
  let balanceCache = null;
  const BALANCE_TTL_MS = 20_000;
  let balanceInflight = null;

  app.get('/api/faucet', readGate, async (_req, res) => {
    if (!kp) return res.json({ available: false, reason: 'faucet not configured' });
    if (!balanceCache || Date.now() - balanceCache.at > BALANCE_TTL_MS) {
      balanceInflight ??= conn.getBalance(kp.publicKey)
        .catch(() => 0)
        .finally(() => { balanceInflight = null; });
      balanceCache = { at: Date.now(), sol: await balanceInflight };
    }
    const sol = balanceCache.sol;
    res.json({
      available: sol > DRIP_SOL * LAMPORTS_PER_SOL * 2,
      address: kp.publicKey.toBase58(),
      dripSol: DRIP_SOL,
      dripMempire: DRIP_MEMPIRE,
      coins: starters.map((c) => c.ticker),
      balanceSol: sol / LAMPORTS_PER_SOL,
    });
  });

  app.post('/api/faucet', requireWallet('faucet'), async (req, res) => {
    if (!kp) return res.status(503).json({ error: 'faucet not configured' });

    const address = req.wallet;
    let owner;
    try {
      owner = new PublicKey(address);
    } catch {
      return res.status(400).json({ error: 'not a valid address' });
    }

    /**
     * Refuse before recording anything if the faucet cannot pay.
     *
     * The claim below is written *before* the transaction is sent and is
     * one-per-address-forever, which is the right trade against double-spending
     * a faucet — but it means a dry faucet permanently burns every address that
     * touches it, and they stay burned after a top-up. Checking the balance
     * first turns that into a message someone can act on.
     */
    const funds = await conn.getBalance(kp.publicKey).catch(() => 0);
    if (funds < DRIP_SOL * LAMPORTS_PER_SOL + 20_000_000) {
      return res.status(503).json({
        error: 'the devnet faucet is empty — nothing was claimed, try again later',
        balanceSol: funds / LAMPORTS_PER_SOL,
        needSol: DRIP_SOL,
      });
    }

    // One claim per address, ever. Checked before anything is signed, and
    // written before the transaction is sent — a double-spend of the faucet is
    // worse than a claim that failed after being recorded, because the player
    // can retry a failure and cannot un-drain a faucet.
    if (claims) {
      const prior = await claims.findOne({ _id: address });
      if (prior) {
        return res.status(409).json({
          error: 'this address has already claimed',
          claimedAt: prior.at,
        });
      }
      await claims.insertOne({ _id: address, at: new Date() });
    }

    // Declared outside the try so the catch can tell "nothing was sent" from
    // "the SOL already left" — the distinction the claim record turns on.
    const signatures = [];
    try {
      /**
       * Two transactions, not one.
       *
       * Eight coins is eight ATA creations plus eight transfers plus the SOL
       * drip, and that packs to 1247 bytes against a 1232-byte limit — a
       * failure that only appears once the whole starter kit is assembled, so
       * a smaller test would have passed. Split four and four, SOL riding with
       * the first.
       *
       * Not atomic, and that is survivable: the claim record is released on
       * any failure, so a half-delivered kit is retried from the beginning and
       * the idempotent ATA creation makes the repeat harmless.
       */
      const half = Math.ceil(starters.length / 2);
      const batches = [starters.slice(0, half), starters.slice(half)];

      for (const [i, batch] of batches.entries()) {
        const tx = new Transaction();
        if (i === 0) {
          tx.add(SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: owner,
            lamports: Math.round(DRIP_SOL * LAMPORTS_PER_SOL),
          }));
          // Rides the first batch for the same reason the SOL does: it is two
          // instructions, and the second batch is the one closer to the size
          // limit that split these in half to begin with.
          const mTo = getAssociatedTokenAddressSync(MEMPIRE_MINT, owner);
          tx.add(createAssociatedTokenAccountIdempotentInstruction(
            kp.publicKey, mTo, owner, MEMPIRE_MINT,
          ));
          tx.add(createTransferInstruction(
            getAssociatedTokenAddressSync(MEMPIRE_MINT, kp.publicKey),
            mTo, kp.publicKey,
            BigInt(DRIP_MEMPIRE) * BigInt(10) ** BigInt(MEMPIRE_DECIMALS),
          ));
        }
        for (const c of batch) {
          const mint = new PublicKey(c.mint);
          const from = getAssociatedTokenAddressSync(mint, kp.publicKey);
          const to = getAssociatedTokenAddressSync(mint, owner);
          tx.add(createAssociatedTokenAccountIdempotentInstruction(
            kp.publicKey, to, owner, mint,
          ));
          tx.add(createTransferInstruction(
            from, to, kp.publicKey,
            BigInt(DRIP_TOKENS) * BigInt(10) ** BigInt(c.decimals ?? 6),
          ));
        }

        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = kp.publicKey;
        tx.sign(kp);
        const signature = await conn.sendRawTransaction(tx.serialize());
        /*
         * Recorded on send, not on confirm.
         *
         * This sat after `confirmTransaction`, and a confirmation that times
         * out on a transaction which actually landed is the ordinary devnet
         * failure, not an exotic one. On the first batch — the one carrying
         * the entire drip of SOL — that left `signatures` empty, the catch
         * below read it as "nothing was sent", and it deleted the
         * one-claim-ever record for SOL that had already gone out. Claim,
         * time out, claim again: the faucet pays every time and the ledger
         * says it never paid at all.
         *
         * A signature in hand means the network has the transaction. Whether
         * it confirms is a separate question, and the answer to it must not
         * decide whether the claim is released.
         */
        signatures.push(signature);
        const confirmed = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, 'confirmed',
        );
        /*
         * And a confirmed transaction can still have failed. `confirmTransaction`
         * resolves with the error rather than throwing it, so discarding the
         * result reported a drip that reverted on chain as `ok: true` — the
         * player is told their kit is on the way and nothing ever arrives.
         */
        if (confirmed?.value?.err) {
          throw new Error(`drip failed on chain: ${JSON.stringify(confirmed.value.err).slice(0, 120)}`);
        }
      }

      recordEvent(db, {
        type: 'faucet.claim',
        address,
        props: { sol: DRIP_SOL, mempire: DRIP_MEMPIRE, coins: starters.length },
      });

      res.json({
        ok: true,
        signature: signatures[0],
        signatures,
        sol: DRIP_SOL,
        coins: starters.map((c) => c.ticker),
      });
    } catch (e) {
      /*
       * Release the claim only if nothing was actually sent.
       *
       * This used to delete unconditionally, so that a network failure was not
       * a permanent lockout. But the kit ships as two transactions and the
       * *first* carries the entire 0.35 SOL — so any failure in the second
       * handed back a claim record for SOL already spent. Batch two fails
       * whenever the faucet runs out of any one of the later coins, which is
       * the normal end-state of a devnet faucet, and the loop is then: claim,
       * fail, claim again, forever.
       *
       * Nothing sent is still a clean retry. Something sent is recorded as
       * partial, which keeps the one-claim rule and leaves a trail explaining
       * why somebody got half a kit.
       */
      if (claims) {
        if (signatures.length === 0) {
          await claims.deleteOne({ _id: address }).catch(() => {});
        } else {
          await claims.updateOne(
            { _id: address },
            { $set: { partial: true, batches: signatures.length, signatures, failedAt: new Date() } },
          ).catch(() => {});
        }
      }
      res.status(502).json({
        error: String(e?.message ?? e).slice(0, 200),
        delivered: signatures.length ? { sol: DRIP_SOL, batches: signatures.length } : null,
      });
    }
  });
}
