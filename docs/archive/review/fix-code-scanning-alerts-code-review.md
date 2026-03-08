# Code Review: fix-code-scanning-alerts

Date: 2026-03-09
Review rounds: 2

## Round 1 — Initial Review

### Functionality Findings

#### [F1] Minor — Modulo bias comment inaccuracy
- **Problem**: Comment says "Avoid modulo bias" but `Math.floor(byte / 256 * 3)` produces distribution 86:85:85, same as `% 3`
- **Impact**: Misleading comment; no functional impact (dummy credential count 1-3)
- **Resolution**: Fixed — comment changed to "Reduce modulo bias (negligible for dummy credential count 1-3)"

#### [F2] Minor — Redundant `existsSync` guard around `O_CREAT|O_EXCL`
- **Problem**: `existsSync()` check wraps atomic `O_CREAT|O_EXCL` which already handles existence
- **Impact**: Code clarity; no functional impact
- **Resolution**: Fixed — removed redundant `existsSync` guard

### Security Findings

#### [S1] Minor — Main seed path retains TOCTOU pattern (flagged by Security + Testing)
- **Problem**: smoke test path fixed with `O_CREAT|O_EXCL` but main `seedUsers` path still used `writeFileSync` + `chmodSync` (permission gap between write and chmod)
- **Impact**: Low risk (single-process script, local file)
- **Resolution**: Fixed — unified to `writeFileSync` with `{ mode: 0o600 }` option

### Testing Findings

No additional findings beyond those merged with F1, F2, S1 above.

## Round 2 — Verification

All three perspectives confirmed:
- F1: Comment corrected
- F2: `existsSync` guard removed, `O_CREAT|O_EXCL` sole guard
- S1: Main seed path uses `writeFileSync` with `{ mode: 0o600 }`
- Unused `chmodSync` import removed
- No regressions or new issues introduced

## Resolution Summary

| Finding | Severity | Status |
| --- | --- | --- |
| F1: Modulo bias comment inaccuracy | Minor | Resolved |
| F2: Redundant existsSync guard | Minor | Resolved |
| S1: Main seed path TOCTOU | Minor | Resolved |
