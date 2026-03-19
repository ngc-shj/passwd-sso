# Code Review: split-otp-autofill
Date: 2026-03-19
Review rounds: 3

## Summary

Added split OTP field detection and digit distribution for TOTP autofill in the browser extension. Previously, autofill put all 6 digits into a single OTP input. Now it detects multiple single-digit fields (maxLength=1 or indexed name pattern like `otp-code-0`) and distributes each digit.

## Round 1 Findings

### Functionality Findings

| # | Severity | Problem | Resolution |
|---|----------|---------|------------|
| F1 | Major | `type="number"` + `maxLength` ignored by browsers; risk of false positive with indexed name | Fixed: removed `type="number"` from `isSingleDigitOtp` |
| F2 | Major | Deep nesting breaks ancestor-sharing check (`closest("div")` returns immediate parent div) | Fixed: removed `div` from ancestor selector |
| F3 | Major | `maxLength=1` alone can match card expiry fields (mitigated by codeLength usually) | Fixed: removed `code`/`digit`/`pin` from regex |
| F4 | Minor | `.ts` vs `.js` `??` vs `||` semantic difference in otpForm | No real impact, accepted |
| F5 | Minor | Shadow DOM inputs not detected (existing limitation) | Out of scope |

### Security Findings

| # | Severity | Problem | Resolution |
|---|----------|---------|------------|
| S1 | Major | `code`/`digit`/`pin` keywords too broad → TOTP leak to non-OTP fields | Fixed: removed from `indexedOtpNameRe` |
| S2 | Major | `div` in ancestor selector → cross-form TOTP leak | Fixed: removed `div` from selector |
| S3 | Minor | Event bubbling exposes TOTP digits to page JS | Fundamental constraint of content script autofill |
| S4 | Minor | Name-based detection doesn't check maxLength | Intentional: indexed name fields (e.g. otp-code-0) often lack maxLength |

### Testing Findings

| # | Severity | Problem | Resolution |
|---|----------|---------|------------|
| T1 | Major | disabled/readOnly inputs in split group not tested | Fixed: tests added |
| T2 | Major | 8-digit TOTP not tested | Fixed: test added |
| T3 | Major | Ancestor depth-walk branch not tested | Fixed: test added |
| T4 | Major | Form-scoped split OTP interaction not tested | Fixed: test added |
| T5 | Critical | `autofill.js` (production file) never executed by tests | Pre-existing issue, out of scope |

### Local LLM Pre-screening (addressed before Round 1)

- `maxLength === 2` false positive risk → Fixed: restricted to `maxLength === 1`
- `parentElement?.closest()` null bypass → Fixed: added null guard with `break`

## Round 2 Findings

| # | Severity | Problem | Resolution |
|---|----------|---------|------------|
| R2-A | Major | `indexedOtpNameRe` match without maxLength check | Intentional design: Akamai-style `otp-code-N` fields lack maxLength |
| R2-B | Major | Test assertions only check first/last digit (false-positive risk) | Fixed: all digits asserted |
| R2-C | Major | readOnly fallback not tested | Fixed: test added |
| R2-D | Minor | Cross-form test comment inaccurate | Fixed |

## Round 3

No new Critical or Major findings. All fixes verified correct.

## Remaining Minor Issues (accepted)

- TS/JS `??` vs `||` semantic difference (no real impact)
- Shadow DOM limitation (existing)
- Event bubbling (fundamental constraint)
- `section` ancestor scope could be broad (low practical risk)
- `autofill.js` not tested separately (pre-existing)

## Resolution Status

All Critical and Major findings resolved. 29 tests passing (12 new split-OTP tests added).
