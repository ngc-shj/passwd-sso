#!/usr/bin/env bash
# check-settings-card-layout.sh — guard the unified settings-card layout pattern.
#
# After the unify-settings-page-layout work (commits 8a78fec9..62ab7524),
# every developer-tools settings card under src/components/settings/developer/
# and src/components/team/security/ shares the same shape:
#
#   <Card>
#     <SectionCardHeader title=... description=... />
#     <CardContent>
#       <section> [create button or filter row] </section>
#       <Separator />
#       <section>
#         <h3>{ "Issued ..." | "Registered ..." }</h3>
#         { active list }
#         { inactive list via <InactiveItemsSection /> if applicable }
#       </section>
#     </CardContent>
#   </Card>
#
# This script catches NEW cards that drift from the pattern. It runs only
# against files added or modified vs main (not the whole repo) — pre-existing
# patterns in unrelated files are out of scope.
#
# Gates (each fails with a specific message):
#   (a) raw `<Collapsible open={showInactive...}>` for an active/inactive toggle
#       — must use <InactiveItemsSection />
#   (b) bespoke `<button onClick={() => setShowInactive...}>` + <ChevronDown>
#       — must use <InactiveItemsSection />
#   (c) `border-t pt-4` on a <section> — replaced by <Separator />
#
# Scope:
#   src/components/settings/developer/*.tsx (excluding *.test.tsx, helpers)
#   src/components/team/security/*.tsx (excluding *.test.tsx, helpers)
#
# The InactiveItemsSection helper itself is allowed to use raw Collapsible
# primitives — that's its job — and is therefore excluded from the scan.

set -uo pipefail

RED='\033[0;31m'
RESET='\033[0m'

BASE_REF="${SETTINGS_CARD_LAYOUT_BASE:-main}"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  printf "${RED}check-settings-card-layout: base ref '%s' not found. Set SETTINGS_CARD_LAYOUT_BASE=<ref> if your CI uses a different default branch.${RESET}\n" "$BASE_REF" >&2
  exit 2
fi

# Identify added or modified settings-card files since BASE_REF.
# Status filter: A=added, M=modified, R=renamed (treat as added).
CHANGED_LIST=$(git diff --name-only --diff-filter=AMR "$BASE_REF...HEAD" 2>/dev/null \
  | grep -E '^src/components/(settings/developer|team/security)/[^/]+\.tsx$' \
  | grep -v -E '\.test\.tsx$' \
  | grep -v -E '/inactive-items-section\.tsx$' \
  || true)

if [ -z "$CHANGED_LIST" ]; then
  echo "check-settings-card-layout: no changed settings-card files (vs $BASE_REF) — skipping"
  exit 0
fi

CHANGED_COUNT=$(echo "$CHANGED_LIST" | wc -l | tr -d ' ')

scan_pattern() {
  local regex="$1" msg="$2" file="$3" matches
  if matches=$(grep -nE "$regex" "$file" 2>/dev/null); then
    printf "%s\n" "${file}: ${matches}"
    printf "${RED}  ✗ FORBIDDEN: %s${RESET}\n" "$msg" >&2
  fi
}

VIOLATIONS=$(
  echo "$CHANGED_LIST" | while IFS= read -r file; do
    [ -f "$file" ] || continue

    # Gate (a): raw <Collapsible open={showInactive...}> for active/inactive toggle.
    # Matches showInactive, showInactiveSa, showInactiveTokens, etc.
    scan_pattern "<Collapsible[[:space:]]+open=\{showInactive" \
      "raw <Collapsible open={showInactive...}> — replace with <InactiveItemsSection> from @/components/settings/shared/inactive-items-section" \
      "$file"

    # Gate (b): bespoke <button onClick={() => setShowInactive...(...)}>.
    # The hand-rolled chevron-button pattern that pre-dated the helper.
    scan_pattern "<button[^>]*onClick=\{[^}]*setShowInactive" \
      "bespoke <button onClick={...setShowInactive...}> — replace with <InactiveItemsSection> from @/components/settings/shared/inactive-items-section" \
      "$file"

    # Gate (c): border-t pt-4 on a <section> — visual divider that was
    # replaced by <Separator /> across all developer-tools cards.
    scan_pattern '<section[^>]*className="[^"]*border-t pt-4' \
      "<section className=\"...border-t pt-4\"> — replace with <Separator /> + <section className=\"space-y-3\"> per the unified divider pattern" \
      "$file"
  done
)

if [ -n "$VIOLATIONS" ]; then
  printf "${RED}check-settings-card-layout: violations in %d changed settings-card file(s)${RESET}\n" "$CHANGED_COUNT" >&2
  printf "  See docs/settings-card-pattern.md for the unified layout reference.\n" >&2
  exit 1
fi

echo "check-settings-card-layout: ok ($CHANGED_COUNT changed settings-card file(s) scanned)"
