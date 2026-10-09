/** Claim the money side of a match report exactly once. MongoDB and the local
 * store both apply this conditional update atomically. W/L claims are separate.
 * A process crash after claiming can still lose a leaderboard update; this
 * guards retries from inflating money, it is not a multi-document transaction. */
export async function claimMoneyCredit(credits, creditId) {
  const claim = await credits.updateOne(
    { _id: creditId, moneyCredited: false },
    { $set: { moneyCredited: true, creditedAt: new Date() } },
  );
  return claim.matchedCount === 1;
}
