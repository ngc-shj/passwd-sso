# Coding Deviation Log: extension-passkey-provider
Created: 2026-04-04T03:20:00+09:00

## Deviations from Plan

### D1: clientDataJSON origin handling
- **Plan description**: MAIN world constructs clientDataJSON with correct origin; background uses it for signing
- **Actual implementation**: Initially, create flow built clientDataJSON in background with `origin: ""`. Fixed in simplify review to pass clientDataJSON from MAIN world through bridge to background.
- **Reason**: Oversight in initial implementation — create flow was asymmetric with assertion flow
- **Impact scope**: passkey-provider.ts, webauthn-bridge-lib.ts, messages.ts

### D2: ACTIONABLE_TYPES hoisted to module level
- **Plan description**: Plan did not specify where ACTIONABLE_TYPES constant should live
- **Actual implementation**: Hoisted from function-local to module-level constant (was recreated per call)
- **Reason**: Identified during simplify review as unnecessary allocation
- **Impact scope**: extension/src/background/index.ts

### D3: Sign flow optimized — overview omitted from PUT
- **Plan description**: Plan described full blob + overview re-encryption for counter update
- **Actual implementation**: Only blob is re-encrypted; overview omitted from PUT (server accepts blob-only update)
- **Reason**: Simplify review identified unnecessary decrypt/encrypt of unchanged overview
- **Impact scope**: passkey-provider.ts

---
