# Journal update: stage 2 (Trades)

Changed files: `index.html` and `api/member.js`. No new server functions; still 10 of 12.
No stored data is rewritten or removed. Every existing entry, day note, account and point stays exactly as it was.

## What's new
- **Trades tab gallery.** Every trade is a card with its screenshot, P&L, ✓ Verified or "By hand", tags, and whether a breakdown is still owed.
  - New filters: ✓ Verified only, Breakdown owed.
  - The old list is still there (Gallery / List toggle). The search and the outcome, account, model and tag filters work the same.
- **Trade view.** Click any trade to see the trader's chart, the numbers, the breakdown (grade, emotion, rules, mistakes, tags) and the mentor's review together.
  - Ask your mentor, and Edit or Write breakdown, are right there.
- **CSV numbers are locked.** On a CSV-imported trade, these can't be changed: symbol, side, date, times, contracts, prices, outcome and P&L.
  - Notes, screenshots, tags and review fields stay editable.
  - The server enforces the lock too, so ✓ Verified can't be faked.
  - Only values the CSV actually supplied are locked. Blanks can still be filled in by hand.
- **Verify by matching.** When a CSV row matches a trade already logged by hand, that entry turns ✓ Verified instead of being added twice.
  - A match means: same day, same symbol, same P&L to the cent, and the same entry time when both entries have one.
  - The hand entry's notes, screenshots, tags and review are kept. Only empty fields are filled from the CSV.
  - The import message reports how many trades were verified.
- **Calendar dots.** Each logged day shows three dots: plan written, every trade broken down, recap written.
- **Stats.** "What works best" has two new factors:
  - Tags: win rate and P&L for each tag.
  - How it was logged: verified vs by hand.
  - The existing Mistakes factor already shows the cost of each mistake.

- **P&L cards are mobile-only now.** The 16:9 computer card is gone. Every device, including a computer, makes the 1080 × 1920 story card for Instagram, TikTok and X.
  - The Profile / Ledger styles now show on a computer too.
  - Only the image is affected. No stored data changes.

## Tested
- API tests: 17 passed.
- Seeded old and new data, then ran: a hand trade verified by CSV (notes and tags kept), a re-import (no duplicates), a tampering attempt on CSV numbers (ignored), and an edit to a hand trade (still allowed).
- The stage 1 Today flow and export still work. No page errors on desktop or phone.

## Before deploying
Download an admin backup first, as usual.
