# Plan Review: refine-extension-popup
Date: 2026-03-28
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
- [F-1] Major: Team vault badge count scope → Resolved (clarified getCachedEntries includes both)
- [F-2] Major: Stale badge during navigation → Resolved (clear on status=loading)
- [F-3] Major: tabHost absent definition → Skipped (already handled by extractHost → null)
- [F-4] Minor: clearAllTabBadges async → Resolved (fire-and-forget documented)

## Security Findings
- [S-1] Major: isHostMatch subdomain asymmetry → Analyzed, kept as-is (same as 1Password/Bitwarden)
- [S-2] Minor: isOwnAppPage async path → No action needed
- [S-3] Minor: Tab URL TOCTOU → Pre-existing, no action

## Testing Findings
- [T-1] Critical: Button removal regression test → Resolved (added to plan)
- [T-2] Critical: Badge count tests mandatory → Resolved (added to plan)
- [T-3] Major: MatchList filter tests → Resolved (added to plan)
- [T-4] Minor: App.test.tsx mock cleanup → Resolved (added to plan)
