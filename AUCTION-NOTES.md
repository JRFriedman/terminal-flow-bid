# Auction Debugging Notes

## FLOW Auction (2026-02-26) — Failed Bids

### Root Causes (in order of discovery)

1. **API response mismatch**: `buildBidTx` API returns `transactions` array, not `steps`. Code referenced `result.steps.length` which was `undefined`.
   - Fix: `const steps = result.steps || result.transactions || []`
   - Also had a second reference to `result.steps.length` in the log line

2. **Viem simulation revert**: viem simulates transactions before sending by default. When the approve (step 1) and bid (step 2) are built together, the bid simulation fails because the approve hasn't been mined yet.
   - Fix: pass `gas: 500_000n` to `sendTransaction` to skip simulation

3. **`BidMustBeAboveClearingPrice()`**: The contract rejects bids where the encoded max price Q96 is below the current clearing price. Since we build the tx then submit it, the clearing price can move between build and submit.
   - Fix: always fetch clearing price right before bidding, bid 15% above it

4. **`AuctionEnded()`**: By the time we fixed issues 1-3, the auction had ended.

5. **Strategy dies on first bid failure**: `placeBid` threw an error that killed the entire strategy. No retry logic.
   - Fix: `placeBid` now returns `boolean`, strategy continues polling on failure and retries with updated clearing price

### Revert Error Selectors
- `0xa0e92984` → `AuctionEnded()`
- `0x5f259e52` → `BidMustBeAboveClearingPrice()`

## KLARA Auction (2026-02-26) — Failed Bids

### Root Cause

6. **Q96 tick-spacing alignment**: The `buildBidTx` API aligns the Q96 price to the contract's tick spacing. When bidding only slightly above floor (e.g. $25.25K vs $25K floor, or even $26K), the aligned Q96 price rounds **down to exactly the floor price**. Contract requires strictly above.
   - `maxPriceQ96Aligned: 1980704062800` === `floorPrice: 1980704062800`
   - A 1% or even 4% FDV buffer is not enough to survive tick alignment
   - Fix: `bid.ts` now compares `maxPriceQ96Aligned` against floor/clearing price after building tx. If equal or below, bumps FDV by 15% and rebuilds (up to 5 retries) until Q96 is strictly above.

7. **No retry when clearing price is unknown**: When `clearingPrice` is None (no bidders yet), `impliedFdv` stays 0, so the retry loop (`if bidsPlaced === 0 && impliedFdv > 0`) never triggers. Strategy gets stuck.
   - Fix: retry loop now fires even when `impliedFdv === 0`, using the bumped `currentFdv` from the failed bid attempt.

### Key Learnings
- Always bid above clearing price, not at or below it
- Rebuild tx data right before submitting (don't cache stale tx data)
- Never let the strategy die from a single bid failure
- **Q96 tick alignment can round your price down to the floor** — always verify `maxPriceQ96Aligned > floorPrice` before submitting
- **Simulate the bid tx after approve is confirmed** — catches reverts before spending gas
- 1% FDV buffer is NOT enough; need 5%+ and post-build Q96 verification
- The auction contract at `0xF762AC1553c29Ef36904F9E7F71C627766D878b4` is the bid submission target
- USDC approval goes to the same contract
