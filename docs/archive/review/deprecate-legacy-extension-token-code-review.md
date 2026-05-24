# Code Review: deprecate-legacy-extension-token

Date: 2026-05-24
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

No findings.

## Security Findings

[S1] Minor: Audit row dead-letters (DB row never written) for legacy-issuance attempts
- File: src/app/api/extension/token/route.ts:56-63
- Problem: `ANONYMOUS_ACTOR_ID` lacks a real User, so `resolveTenantId` returns null and the row is sent to `deadLetterLogger.warn` instead of `audit_logs`. SOC dashboards filtering on `action = EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` won't see attempts.
- Status: **Accepted — design per C6**. The plan §C6 explicitly documents dead-letter routing as the intentional behaviour; `logger.warn` at route.ts:65-69 is the primary observability surface. Scenario E in the plan documents this trade-off for operators.

[S2] Minor: Audit row records ANONYMOUS even when attacker has a valid session/Bearer
- File: src/app/api/extension/token/route.ts:37-78
- Problem: Same-origin XSS could reach this endpoint with a valid session cookie, but the handler intentionally skips `auth()` (C1 forbidden-pattern), erasing the victim's identity in the audit row.
- Status: **Accepted — design per C1 + C6**. The C1 invariant "regardless of session state" was a deliberate choice to keep handler logic minimal and uniform; enriching with `auth()` would require revisiting C1. The forensic loss is mitigated by the `logger.warn { ip }` surface which still records the attack source. Trade-off documented in deviation log §S2 Acceptance.

[S3] Minor: 410 response lacks `Cache-Control: no-store`
- File: src/app/api/extension/token/route.ts:72-77
- Problem: RFC 7231 lists 410 as cacheable by default; a misconfigured intermediary could memoize the 410.
- Status: **RESOLVED**. Added `"Cache-Control": "no-store"` to the headers arg of `errorResponse(...)`. Test asserts the header.

[S4] Minor: `Sunset` header not set (RFC 9745 / 8594 companion to `Deprecation`)
- File: src/app/api/extension/token/route.ts:71-77
- Problem: RFC 9745 §2 recommends pairing `Deprecation` with `Sunset`.
- Status: **Accepted — out of scope for pre-1.0 development**. Per [[feedback_pre_1_0_deprecation_wording]] and pre-1.0 conventions, formal RFC 9745 `Sunset` mechanics are overkill before stability commitments exist. No client SDK consumes this signal today. Reconsider post-1.0 if external clients ship.

## Testing Findings

[T1] Minor: 429 rate-limit test lacks negative assertion that audit emission did NOT occur
- File: src/app/api/extension/token/route.test.ts:129-140
- Status: **RESOLVED**. Added `expect(mockLogAudit).not.toHaveBeenCalled();` to the "returns 429 when IP rate limit exceeded" test, fixing the C7 invariant that rate-limit caps audit-row writes.

[T2] Minor: Audit emission test does not assert ip / userAgent propagation
- File: src/app/api/extension/token/route.test.ts:113-122
- Status: **RESOLVED**. Test now passes `User-Agent: test-agent/1.0` header and asserts both `ip: "1.2.3.4"` and `userAgent: "test-agent/1.0"` in the audit emission. Test name updated to "emits ANONYMOUS_ACTOR_ID audit row with EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED + ip/userAgent".

[T3] Minor: Vestigial unused `mockCheck` in hoisted mock block
- File: src/app/api/extension/token/route.test.ts:13, 24, 50
- Status: **RESOLVED**. Removed `mockCheck` from hoisted block; inlined `vi.fn().mockResolvedValue({ allowed: true })` into the `createRateLimiter` mock with a comment explaining the shape is unused (the real path goes through `checkIpRateLimit`).

## Adjacent Findings

None.

## Quality Warnings

None.

## User-Requested Modification (post-Round 1)

[U1] Minor: i18n message wording — drop formal "deprecation" language for pre-1.0
- Files: messages/ja/ApiErrors.json, messages/en/ApiErrors.json
- User request: "開発中なので、廃止されました、とかいらないです。"
- Status: **RESOLVED**.
  - ja: 「このエンドポイントは廃止されました...」 → 「このエンドポイントは利用できません...」
  - en: "This endpoint has been retired..." → "This endpoint is not available..."
- Saved as feedback memory: `feedback_pre_1_0_deprecation_wording.md` — in pre-1.0 dev, avoid 廃止/retired/deprecated wording; use 利用できません/not available.

## Recurring Issue Check

### Functionality expert
- R1-R37: all checked, no findings (see Round 1 sub-agent output for per-rule status).

### Security expert
- R1-R37: all checked. R17 (logging/monitoring) and R33 (audit trail integrity) PARTIAL — see S1/S2 (accepted per C6 design). R37 (deprecation header standard) PARTIAL — see S4 (accepted for pre-1.0).
- RS1: pass (XSS surface reduction verified — CliTokenCard sweep complete).
- RS2: pass (proxy auth invariants unchanged).
- RS3: pass (DELETE revoke flow untouched).
- RS4: pass (no new auth bypass introduced).

### Testing expert
- R1-R37: all checked, no findings post-fix.
- RT1: pass post-fix (was partial — T1 resolved).
- RT2: pass (mock alignment verified).
- RT3: pass.
- RT4: pass (no race conditions).
- RT5: pass (no parallel .js/-lib.ts test files in scope).

## Resolution Status

### [S1] Minor [Audit dead-letter] — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: forensic visibility loss for unauthenticated callers; SOC must check logger.warn instead of audit_logs DB
  - Likelihood: low — legitimate post-deploy traffic is zero; surprise traffic is detected via the warn log
  - Cost to fix: medium — would require either enriching with auth() (contradicts C1) or adding a system-actor variant of logAuditAsync (~30+ LOC + tests)
- **Orchestrator sign-off**: documented C6 design trade-off, accepted.

### [S2] Minor [ANONYMOUS identity always] — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: chain-of-custody broken on the audit row for authenticated attacks via XSS
  - Likelihood: low — XSS still leaves session-cookie traces in HTTP access logs; ip+UA in the audit row plus the warn log provide enough for triage
  - Cost to fix: medium — same as S1 (would need to relax C1 forbidden-pattern)
- **Orchestrator sign-off**: trade-off documented in plan §4b S3 reconciliation, accepted.

### [S3] Minor [Cache-Control no-store] — Fixed
- Action: added `"Cache-Control": "no-store"` to handlePOST 410 response headers
- Modified file: src/app/api/extension/token/route.ts:75; src/app/api/extension/token/route.test.ts:97 (test assertion)

### [S4] Minor [Sunset header] — Out of scope (pre-1.0)
- **Anti-Deferral check**: out of scope (different feature — formal SemVer stability mechanics)
- **Justification**: per [[feedback_pre_1_0_deprecation_wording]], pre-1.0 projects don't carry RFC 9745 Sunset commitments. No client SDK consumes the signal today.
- **TODO**: reconsider when reaching v1.0 / when external SDK clients are documented.

### [T1] Minor [429 negative assertion] — Fixed
- Action: added `expect(mockLogAudit).not.toHaveBeenCalled();` to 429 test
- Modified file: src/app/api/extension/token/route.test.ts:138-140

### [T2] Minor [audit ip/userAgent assertion] — Fixed
- Action: passed `User-Agent: test-agent/1.0` in request and asserted both `ip: "1.2.3.4"` and `userAgent: "test-agent/1.0"` in audit emission expectation
- Modified file: src/app/api/extension/token/route.test.ts:113-126

### [T3] Minor [vestigial mockCheck] — Fixed
- Action: removed `mockCheck` from hoisted block; inlined the rate-limiter check stub in the `createRateLimiter` mock
- Modified file: src/app/api/extension/token/route.test.ts:13 (removed), :24 (removed), :50 (inlined with explanatory comment)

### [U1] Minor [i18n deprecation wording] — Fixed
- Action: simplified messages per user feedback "開発中なので、廃止されました、とかいらないです。"
- Modified files: messages/ja/ApiErrors.json:74; messages/en/ApiErrors.json:74
- Memory persisted: feedback_pre_1_0_deprecation_wording.md
