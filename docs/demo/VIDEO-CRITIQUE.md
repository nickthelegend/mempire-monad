# Critique of `mempire-metropolis.mp4` (13 Oct, 2:21), as a Metropolis judge

Watched with the `watch` skill (16 keyframes, plus the cut's frame QA sheets). Verdict: **honest but thin.** It proves that the hosted app runs on Monad testnet. It does not show the product.

**What's wrong:**

1. **The game is too small to read.**
   - The desktop window renders the app as a 430 px column inside a 1360 px window, then scales it into a 1333 px slot.
   - About 60% of the frame is empty purple, and card names, pills and prices are unreadable at 1080p.
   - The phone window on the right is the only part a viewer can read.
2. **31 s of slides before any product.**
   - The intro is motion graphics, not the product "in actual operation".
   - Problem and user are never stated in plain words, and the README's user (a crypto-native casual player who wants stakes without wallet friction) is missing from the video.
3. **The full loop is missing.** Not shown:
   - the passkey (Mera) sign-up: a guest was used instead;
   - a Pyth-priced mint;
   - a chest opened (gasless or not);
   - joining a clan or the clan war;
   - the leaderboard explained;
   - the season pass;
   - the P256 passkey check.

   The video jumps from onboarding straight to a match.
4. **Sponsor proof is weak.**
   - Chainlink CRE appears only as a side board ("meta from 5 h ago"), with no write shown.
   - Pyth isn't shown working.
   - Mera isn't shown at all (a guest was used).
   - The gasless chest is a caption with a hash; nothing on screen proves it.
5. **The Monad moments go past too fast.**
   - The exec/final pills are visible for a few seconds at small size.
   - Commit states are only in the opening heartbeat, and txpool status is never shown.
   - Settlement is a result screen, with no on-chain proof (tx or event) on screen.
6. **Dead air:**
   - a 7 s "tower down" beat with no narration;
   - a held Empire frame;
   - the B (phone) window frozen on REKT for 30 s.
7. **Length.** 2:21 of a 3:00 budget, and it still feels slow, because the time goes to waiting rather than features.

**What the rebuild must do:**
- Fill the frame:
  - record the hero window at the app's own width (≈1100 px wide, so the side boards stay but the column is big);
  - the phone window full height;
  - a narrow rail for live chain proof.
- Open on the product within 15 s, with the problem and user said over real footage.
- Show the whole loop with Mera passkey sign-up:
  - deck;
  - Pyth mint;
  - staked match with pills;
  - tower;
  - Pot Secured;
  - clan join, clan war and leaderboard;
  - the Monad panel with the P256 check;
  - on-chain proof pages for the CRE write and the gasless chest.
- Speed up waits, with an "×2" tag, and never fake.
- Make three videos: the 2:50–3:00 submission cut, the 4–5 min walkthrough, and the ≤ 2:00 pitch.
