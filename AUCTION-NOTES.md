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

### Key Learnings
- Always bid above clearing price, not at or below it
- Rebuild tx data right before submitting (don't cache stale tx data)
- Never let the strategy die from a single bid failure
- The auction contract at `0xF762AC1553c29Ef36904F9E7F71C627766D878b4` is the bid submission target
- USDC approval goes to the same contract
