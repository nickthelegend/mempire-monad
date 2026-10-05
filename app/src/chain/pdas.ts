import { PublicKey } from '@solana/web3.js';

/**
 * Program-derived addresses, byte-identical to the `seeds = [...]` constraints
 * in `chain/programs/mempire/src/lib.rs`. If a seed changes there it must change
 * here in the same commit — a mismatch is a silent "account does not exist",
 * not a compile error.
 *
 * Card and match ids are `u64` written little-endian, matching Rust's
 * `id.to_le_bytes()`.
 */

export const PROGRAM_ID = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');

/** u64 → 8 bytes little-endian. */
function u64le(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

const seed = (s: string) => new TextEncoder().encode(s);

export function configPda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed('config')], programId)[0];
}

export function coinPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed('coin'), mint.toBytes()], programId)[0];
}

export function cardPda(cardId: number | bigint, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed('card'), u64le(cardId)], programId)[0];
}

/** Authority over a card's stake vault — not a token account itself. */
export function vaultAuthorityPda(cardId: number | bigint, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed('vault'), u64le(cardId)], programId)[0];
}

export function matchPda(matchId: number | bigint, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([seed('match'), u64le(matchId)], programId)[0];
}
