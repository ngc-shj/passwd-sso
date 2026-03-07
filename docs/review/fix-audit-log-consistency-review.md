# Code Review: fix-audit-log-consistency

Date: 2026-03-07T00:00:00+09:00
Review round: 2

## Changes from Previous Round

Round 1 findings F-1, F-2, T-1 were fixed. F-3, S-2, T-2~T-5 were skipped (out of scope).

### Round 1 → Round 2 Resolution

- F-1 (destructure → spread pattern): **Resolved** — 3 files updated to `...extractRequestMeta(req)`
- F-2 (auth.ts ip/userAgent comment): **Resolved** — Comment added at auth.ts L309-311
- T-1 (passkey test assertions): **Resolved** — extractRequestMeta mock added, expect.objectContaining used

## Functionality Findings

No findings.

## Security Findings

No findings.

## Testing Findings

No findings.

## Resolution Status

### F-1: vault/recovery-key/generate, recover, reset destructure pattern

- Action: Changed to `...extractRequestMeta(req)` spread pattern
- Modified files: vault/recovery-key/generate/route.ts, vault/recovery-key/recover/route.ts, vault/reset/route.ts

### F-2: auth.ts signIn ip/userAgent limitation

- Action: Added comment explaining Auth.js event limitation
- Modified file: src/auth.ts:309-311

### T-1: passkey/verify test assertions

- Action: Added extractRequestMeta mock, updated logAudit assertion to expect.objectContaining with metadata/ip/userAgent
- Modified file: src/app/api/auth/passkey/verify/route.test.ts:48,172-181
