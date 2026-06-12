# Manual Test: ios-category-landing

UI feature (no snapshot harness) — the grid layout / navigation must be checked by hand.

## Pre-conditions
- Signed in, vault unlocked, cache populated with a mix of entries (some with TOTP, some favorited,
  some tagged, ideally a non-LOGIN type if available).

## Steps / Expected
1. **Grid renders.** Unlock → the landing shows a 2-column grid of category cards (icon + label + count)
   instead of the flat list. "All" is present with the total count.
2. **Counts correct.** Each card's count matches the number of matching entries (cross-check All vs the
   sum is NOT expected — categories overlap). Logins count = login entries (legacy/no-type count as Login).
3. **Empty types hidden.** A type with zero entries (e.g. Secure Notes when none exist) has no card.
   Codes / Favorites cards appear only when count > 0.
4. **Drill-in.** Tap a card → a filtered list of exactly that category's entries → tap an entry → detail.
   Back returns to the grid (not the lock screen).
5. **Tags.** One card per distinct tag; tapping shows entries with that tag.
6. **Search at root.** Type in the bottom search bar → the grid is replaced by flat search results across
   all entries. Clear → the grid returns.
7. **Search within a category.** Drill into a category, then type in the search bar → results are limited
   to that category (composition).
8. **Toolbar/create reachable.** From the grid, the ⋯ menu (Settings / Lock / Sign Out) and the bottom
   Create (+) button work.
9. **Legacy cache.** On a device whose cache predates entryType, all entries appear under Logins; no crash.
   After the next foreground sync, type counts populate.
10. **Screen recording.** Start a screen recording / AirPlay → the grid AND any pushed category list show
    the "Recording — content hidden" overlay (parity with the entry-detail screen).

## Rollback
Revert the branch. No persisted-state or server change; `entryType`/`isFavorite` added to the in-memory
summary + the App Group cache row (optional, backward-compatible) only.
