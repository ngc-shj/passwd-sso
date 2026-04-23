#!/usr/bin/env bash
# Detect E2E test selectors that may break due to source code changes.
#
# Checks two categories against the current git diff (main...HEAD):
#   1. Deleted/renamed route paths referenced in E2E page.goto() calls
#   2. Removed CSS class combinations used in E2E .locator() selectors
#
# Usage: bash scripts/check-e2e-selectors.sh [base-branch]
#   base-branch defaults to "main"

set -euo pipefail

BASE="${1:-main}"
E2E_DIR="e2e"

RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

warnings=0

warn() {
  printf "${YELLOW}  ⚠ %s${RESET}\n" "$1"
  warnings=$((warnings + 1))
}

# ── 1. Route path check ──────────────────────────────────────
#
# Extract deleted route page files from the diff, then check if
# any E2E file references that route path.

printf "${BOLD}▸ Checking deleted/moved route paths vs E2E tests${RESET}\n"

# Find deleted page.tsx files under src/app/
deleted_pages=$(git diff "${BASE}...HEAD" --diff-filter=D --name-only \
  | grep -E '^src/app/.*page\.tsx$' || true)

if [ -n "$deleted_pages" ]; then
  for page_file in $deleted_pages; do
    # Convert file path to route path:
    #   src/app/[locale]/dashboard/settings/account/page.tsx
    #   → /dashboard/settings/account
    route=$(echo "$page_file" \
      | sed 's|^src/app/\[locale\]/||' \
      | sed 's|/page\.tsx$||' \
      | sed 's|^|/|')

    # Search E2E files for this route (with or without locale prefix)
    if grep -rq "$route" "$E2E_DIR/" 2>/dev/null; then
      matching_files=$(grep -rl "$route" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
      warn "Deleted route '$route' is still referenced in: $matching_files"
    fi
  done
fi

# Also check renamed/moved pages (file added + deleted in same diff)
added_pages=$(git diff "${BASE}...HEAD" --diff-filter=A --name-only \
  | grep -E '^src/app/.*page\.tsx$' || true)

# ── 2. CSS class selector check ──────────────────────────────
#
# Extract CSS class selectors used in E2E .locator() calls,
# then check if any of those classes were removed from changed source files.

printf "${BOLD}▸ Checking CSS class selectors in E2E vs source changes${RESET}\n"

# Extract unique CSS class patterns from E2E locator() calls
# Matches patterns like: .locator(".px-4.py-3") or .locator('.border.rounded-md')
e2e_class_selectors=$(grep -roPhE '\.locator\(\s*["\x27](\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)["\x27]' "$E2E_DIR/" 2>/dev/null \
  | sed -E "s/.*\.locator\([\"']//; s/[\"']\)$//" \
  | sort -u || true)

# Get the full list of changed .tsx source files (reused by checks 2, 5, 6)
changed_src=$(git diff "${BASE}...HEAD" --name-only \
  | grep -E '^src/.*\.tsx$' \
  | grep -v '\.test\.' \
  | grep -v '__tests__' || true)

if [ -n "$e2e_class_selectors" ]; then

  if [ -n "$changed_src" ]; then
    # Get removed lines from the diff (lines starting with -)
    removed_classes=$(git diff "${BASE}...HEAD" -- $changed_src \
      | grep -E '^\-.*className=' \
      | grep -v '^\-\-\-' || true)

    for selector in $e2e_class_selectors; do
      # Split compound selector (.border.rounded-md.p-3) into individual classes
      classes=$(echo "$selector" | tr '.' ' ' | xargs)
      for cls in $classes; do
        [ -z "$cls" ] && continue
        # Check if this class appears in removed lines but NOT in added lines
        if echo "$removed_classes" | grep -q "\b${cls}\b" 2>/dev/null; then
          # Verify it's actually gone (not just moved)
          added_with_class=$(git diff "${BASE}...HEAD" -- $changed_src \
            | grep -E '^\+.*className=.*\b'"${cls}"'\b' \
            | grep -v '^\+\+\+' || true)
          if [ -z "$added_with_class" ]; then
            ref_files=$(grep -rl "\\.$cls" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
            warn "CSS class '$cls' removed from source but used in E2E selector '$selector' in: $ref_files"
          fi
        fi
      done
    done
  fi
fi

# ── 3. data-testid check ─────────────────────────────────────
#
# Check if any data-testid values used in E2E were removed from source.

printf "${BOLD}▸ Checking data-testid attributes vs source changes${RESET}\n"

e2e_testids=$(grep -roPhE "data-testid=[\"'][^\"']+[\"']" "$E2E_DIR/" 2>/dev/null \
  | sed -E "s/data-testid=[\"']//; s/[\"']$//" \
  | sort -u || true)

if [ -n "$e2e_testids" ]; then
  for testid in $e2e_testids; do
    # Check if this testid was removed from any source file
    removed=$(git diff "${BASE}...HEAD" \
      | grep -E '^\-.*data-testid=.*'"$testid" \
      | grep -v '^\-\-\-' || true)
    if [ -n "$removed" ]; then
      added=$(git diff "${BASE}...HEAD" \
        | grep -E '^\+.*data-testid=.*'"$testid" \
        | grep -v '^\+\+\+' || true)
      if [ -z "$added" ]; then
        ref_files=$(grep -rl "$testid" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
        warn "data-testid='$testid' removed from source but used in E2E: $ref_files"
      fi
    fi
  done
fi

# ── 4. Deleted export/component name check ───────────────────
#
# When a component or function is removed from source, E2E page objects
# may still reference it by name (e.g. ManageSection deleted →
# expandManageSection in E2E breaks).

printf "${BOLD}▸ Checking deleted exports/components referenced in E2E${RESET}\n"

# Extract names from removed "export function/class/const" lines
removed_exports=$(git diff "${BASE}...HEAD" -- 'src/**/*.tsx' 'src/**/*.ts' \
  | grep -E '^\-.*export (function|class|const|interface|type) ' \
  | grep -v '^\-\-\-' \
  | sed -E 's/.*export (function|class|const|interface|type) ([A-Za-z0-9_]+).*/\2/' \
  | sort -u || true)

# Check if added lines re-introduce the same export (renamed, not deleted)
added_exports=$(git diff "${BASE}...HEAD" -- 'src/**/*.tsx' 'src/**/*.ts' \
  | grep -E '^\+.*export (function|class|const|interface|type) ' \
  | grep -v '^\+\+\+' \
  | sed -E 's/.*export (function|class|const|interface|type) ([A-Za-z0-9_]+).*/\2/' \
  | sort -u || true)

for name in $removed_exports; do
  # Skip if re-exported under the same name
  if echo "$added_exports" | grep -qx "$name"; then
    continue
  fi
  # Case-insensitive search in E2E for the export name
  if grep -riq "$name" "$E2E_DIR/" 2>/dev/null; then
    ref_files=$(grep -ril "$name" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
    warn "Deleted export '$name' is still referenced in E2E: $ref_files"
  fi
done

# ── 5. aria-label check ───────────────────────────────────────
#
# E2E uses getByRole("button", { name: "..." }) which matches aria-label.
# If an aria-label value is removed/changed, E2E selectors break.

printf "${BOLD}▸ Checking aria-label changes vs E2E selectors${RESET}\n"

# Extract aria-label values used in E2E (from { name: "..." } or { name: /.../ })
e2e_aria_names=$(grep -roPhE 'name:\s*["\x27/]([^"\x27/]+)["\x27/]' "$E2E_DIR/" 2>/dev/null \
  | sed -E "s/name:\s*[\"'/]//; s/[\"'/]$//" \
  | grep -v '|' \
  | sort -u || true)

if [ -n "$e2e_aria_names" ] && [ -n "$changed_src" ]; then
  removed_aria=$(git diff "${BASE}...HEAD" -- $changed_src \
    | grep -E '^\-.*aria-label=' \
    | grep -v '^\-\-\-' || true)

  if [ -n "$removed_aria" ]; then
    for name in $e2e_aria_names; do
      [ ${#name} -lt 3 ] && continue
      if echo "$removed_aria" | grep -qi "$name" 2>/dev/null; then
        added_aria=$(git diff "${BASE}...HEAD" -- $changed_src \
          | grep -E '^\+.*aria-label=.*'"$name" \
          | grep -v '^\+\+\+' || true)
        if [ -z "$added_aria" ]; then
          ref_files=$(grep -ril "$name" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
          warn "aria-label containing '$name' removed from source but used in E2E: $ref_files"
        fi
      fi
    done
  fi
fi

# ── 6. id attribute check ────────────────────────────────────
#
# E2E uses #id selectors (e.g. #title, #password, #unlock-passphrase).
# If an id is removed, those selectors break.

printf "${BOLD}▸ Checking id attribute changes vs E2E selectors${RESET}\n"

# Extract #id selectors from E2E (from locator("#foo") or page.locator("#foo"))
e2e_ids=$(grep -roPhE '#[a-zA-Z][a-zA-Z0-9_-]+' "$E2E_DIR/" 2>/dev/null \
  | sed 's/^#//' \
  | sort -u || true)

if [ -n "$e2e_ids" ] && [ -n "$changed_src" ]; then
  removed_ids=$(git diff "${BASE}...HEAD" -- $changed_src \
    | grep -E '^\-.*\bid=' \
    | grep -v '^\-\-\-' || true)

  if [ -n "$removed_ids" ]; then
    for id in $e2e_ids; do
      [ ${#id} -lt 2 ] && continue
      if echo "$removed_ids" | grep -q "\"${id}\"" 2>/dev/null; then
        added_id=$(git diff "${BASE}...HEAD" -- $changed_src \
          | grep -E '^\+.*\bid=.*"'"${id}"'"' \
          | grep -v '^\+\+\+' || true)
        if [ -z "$added_id" ]; then
          ref_files=$(grep -rl "#${id}" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
          warn "id='$id' removed from source but used as #$id in E2E: $ref_files"
        fi
      fi
    done
  fi
fi

# ── 7. data-slot attribute check ─────────────────────────────
#
# shadcn/ui uses data-slot for component identification.
# E2E heavily relies on [data-slot='card'], [data-slot='select-trigger'], etc.

printf "${BOLD}▸ Checking data-slot attribute changes vs E2E selectors${RESET}\n"

e2e_slots=$(grep -roPhE "data-slot=[\"'][^\"']+[\"']" "$E2E_DIR/" 2>/dev/null \
  | sed -E "s/data-slot=[\"']//; s/[\"']$//" \
  | sort -u || true)

if [ -n "$e2e_slots" ]; then
  for slot in $e2e_slots; do
    removed=$(git diff "${BASE}...HEAD" \
      | grep -E '^\-.*data-slot=.*'"$slot" \
      | grep -v '^\-\-\-' || true)
    if [ -n "$removed" ]; then
      added=$(git diff "${BASE}...HEAD" \
        | grep -E '^\+.*data-slot=.*'"$slot" \
        | grep -v '^\+\+\+' || true)
      if [ -z "$added" ]; then
        ref_files=$(grep -rl "data-slot.*$slot" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
        warn "data-slot='$slot' removed from source but used in E2E: $ref_files"
      fi
    fi
  done
fi

# ── 8. i18n value change vs E2E regex selectors ─────────────
#
# E2E tests use regex patterns like /Revoke|失効/i in getByRole({ name })
# and filter({ hasText }). When a messages/ja/*.json value changes, these
# regexes may stop matching.
#
# Approach: extract Japanese strings from E2E regex patterns, then check
# if any appear in the "removed" side of the i18n diff.

printf "${BOLD}▸ Checking i18n value changes vs E2E regex selectors${RESET}\n"

# Get removed Japanese values from messages/ja/ diff (old values that were replaced)
i18n_removed_ja=$(git diff "${BASE}...HEAD" -- 'messages/ja/*.json' \
  | grep -E '^\-\s*"[^"]+"\s*:\s*"' \
  | grep -v '^\-\-\-' \
  | sed -E 's/^\-\s*"[^"]+"\s*:\s*"([^"]+)".*/\1/' \
  | sort -u || true)

if [ -n "$i18n_removed_ja" ] && [ -d "$E2E_DIR" ]; then
  # Extract Japanese text fragments from E2E regex patterns
  # Matches: /English|日本語/i, /English|日本語1|日本語2/i, hasText: /日本語/
  # Split regex alternatives on '|', keep only those containing Japanese chars
  e2e_ja_patterns=$(grep -roE '/[^/]+/' "$E2E_DIR/" 2>/dev/null \
    | sed 's|^[^:]*:||' \
    | tr '|' '\n' \
    | sed 's|^/||; s|/$||; s|/[gi]*$||' \
    | grep '[ぁ-ん]\\|[ァ-ヶ]\\|[一-龠]\\|[Ａ-Ｚ]' \
    | sed 's/[\^$]//g' \
    | sort -u || true)

  if [ -n "$e2e_ja_patterns" ]; then
    for ja_pattern in $e2e_ja_patterns; do
      # Skip very short patterns (single character) — too noisy
      [ "$(echo -n "$ja_pattern" | wc -m)" -lt 2 ] && continue

      # Check if this E2E Japanese pattern matches any removed i18n value
      if echo "$i18n_removed_ja" | grep -qF "$ja_pattern"; then
        # Verify it's NOT in the added side (i.e. the string was truly removed, not just moved)
        i18n_added_ja=$(git diff "${BASE}...HEAD" -- 'messages/ja/*.json' \
          | grep -E '^\+\s*"[^"]+"\s*:\s*"' \
          | grep -v '^\+\+\+' || true)
        if ! echo "$i18n_added_ja" | grep -qF "$ja_pattern"; then
          ref_files=$(grep -rl "$ja_pattern" "$E2E_DIR/" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
          warn "i18n value '$ja_pattern' was changed in messages/ja/ but is still used in E2E regex: $ref_files"
        fi
      fi
    done
  fi
fi

# ── Summary ──────────────────────────────────────────────────

echo ""
if [ "$warnings" -gt 0 ]; then
  printf "${YELLOW}${BOLD}⚠ %d potential E2E breakage(s) detected.${RESET}\n" "$warnings"
  printf "${YELLOW}  Review the warnings above and update E2E tests if needed.${RESET}\n"
  exit 1
else
  printf "  No E2E selector issues detected.\n"
  exit 0
fi
