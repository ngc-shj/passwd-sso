# Code Review: keepassxc-import
Date: 2026-03-10T03:32:00+09:00
Review rounds: 2

## Round 1 — Initial Review

### Functionality Findings

#### [F1] Major — TOTP field key mismatch in XML parser
- **File**: `password-import-parsers.ts` — `parseKeePassXcEntry`
- **Problem**: XML parser read `fields["TOTP"]` but KeePassXC XML exports TOTP under `TOTP Seed` (base32) or `otp` (otpauth:// URI)
- **Impact**: TOTP data silently dropped on import
- **Resolution**: Fixed — fallback chain: `fields["otp"] || fields["TOTP Seed"] || fields["TOTP"]`

#### [F2] Major — Code duplication in root-level entry parsing
- **File**: `password-import-parsers.ts` — `parseKeePassXcXml`
- **Problem**: Root-level `<Entry>` parsing was copy-pasted from `parseKeePassXcGroup`
- **Resolution**: Extracted `parseKeePassXcEntry` helper, used in both locations

#### [F3] Minor — detectFormat ambiguity with 1Password
- **File**: `password-import-parsers.ts` — `detectFormat`
- **Problem**: KeePassXC CSV headers (title/username/password) overlap with 1Password detection
- **Resolution**: Tightened KeePassXC detection to also require `url` + `notes` columns

#### [F4] Minor — Recycle Bin detection locale-dependent
- **File**: `password-import-parsers.ts` — `parseKeePassXcGroup`
- **Problem**: Only checked English "Recycle Bin" and Japanese "ごみ箱" names
- **Resolution**: Added UUID-based detection via `<Meta><RecycleBinUUID>` (locale-independent)

#### [F5] Minor — CSV `/` separator ambiguity undocumented
- **Problem**: KeePassXC uses `/` as group separator in CSV, but group names can contain literal `/`
- **Resolution**: Added code comment documenting the ambiguity and recommending XML importer

### Security Findings

No findings. DOMParser in browsers is inherently safe from XXE attacks. No server-side XML parsing involved.

### Testing Findings

#### [T1] Critical — XML tests permanently skipped
- **File**: `password-import-parsers.test.ts`
- **Problem**: Tests used conditional `itDom` pattern that skipped when `DOMParser` unavailable, but vitest environment was `node`
- **Resolution**: Added `// @vitest-environment jsdom` directive, replaced all `itDom(` with `it(`

#### [T2] Major — use-import-file-flow.test.ts missing XML coverage
- **File**: `use-import-file-flow.test.ts`
- **Problem**: No test for XML file routing to `parseKeePassXcXml`
- **Resolution**: Added mock for `parseKeePassXcXml` and test case "loads XML file and routes to parseKeePassXcXml"

#### [T3] Minor — Missing edge case tests
- **Problem**: No tests for empty group folderPath or case-insensitive header detection
- **Resolution**: Added test for empty group folderPath and case-insensitive KeePassXC detection

## Round 2 — Verification Review

### Functionality Findings
No findings. All 5 previous fixes verified correct and complete.

### Security Findings
No findings. Data flow from file parsing through encrypted blob construction is safe.

### Testing Findings

#### [T4] Minor (new) — File extension checks are case-sensitive
- **File**: `use-import-file-flow.ts` — `loadFile` and `handleDrop`
- **Problem**: `.endsWith(".xml")` etc. are case-sensitive; `.XML` files would be misrouted
- **Resolution**: Fixed — normalize filename with `.toLowerCase()` before extension checks

## Resolution Status

All findings resolved across 2 rounds. Tests: 3978 passed. Build: success.

| ID | Severity | Round | Status |
|----|----------|-------|--------|
| F1 | Major | 1 | Resolved |
| F2 | Major | 1 | Resolved |
| F3 | Minor | 1 | Resolved |
| F4 | Minor | 1 | Resolved |
| F5 | Minor | 1 | Resolved |
| T1 | Critical | 1 | Resolved |
| T2 | Major | 1 | Resolved |
| T3 | Minor | 1 | Resolved |
| T4 | Minor | 2 | Resolved |
