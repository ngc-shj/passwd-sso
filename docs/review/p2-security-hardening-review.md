# Plan Review: p2-security-hardening

Date: 2026-03-07
Review round: 3 (final)

## Round 1 Findings (12 total — all resolved)

- F1 (Critical): ItemKey AAD → resolved: AAD binding added with scope "IK"
- F2 (Critical): CSP wasm-unsafe-eval → resolved: added to proxy.ts + extension manifest
- F3 (Major): TeamPasswordEntryHistory → resolved: ItemKey fields added
- F4 (Major): KdfParams → resolved: kdfMemory/kdfParallelism added
- F5 (Major): Silent fallback → resolved: explicit UI notification added
- F6 (Major): Version mismatch failsafe → resolved: itemKeyVersion in AAD, explicit fail
- F7 (Major): Attachment encryptionMode → resolved: field added
- F8 (Major): Rotation API schema → resolved: new schema defined
- F9 (Major): crypto-domain-ledger → resolved: registration step added
- F10 (Major): kdfType:1 test break → resolved: test update step added
- F11 (Major): Sentry automated tests → resolved: unit tests planned
- F12 (Minor): scrubbing "encrypted" pattern → resolved: added to pattern list

## Round 2 Findings (6 total — all resolved)

- F13 (Major): KdfParams API steps → resolved: steps 20-21 made explicit
- F14 (Major): Rotation API Zod discriminated union → resolved: step 10 updated
- F15 (Major): AAD IK scope ledger registration → resolved: step 5 updated
- S7 (Minor): AAD builder duplication → resolved: reuse buildAADBytes in step 6
- T8 (Minor): null KDF defaults → resolved: return null as-is, client ignores when kdfType=0
- T9 (Minor): History overview → out of scope (pre-existing design)

## Round 3 Findings (3 total — all Minor, resolved)

- F18 (Minor): OV scope needs itemKeyVersion → resolved: step 6 updated to include itemKeyVersion in buildTeamEntryAAD
- F19 (Minor): buildAADBytes not exported → resolved: step 6 notes export requirement
- F20 (Minor): null vs 0 for kdfMemory → resolved: step 21 returns null as-is

## Final Summary

| Round | Critical | Major | Minor | Total | Status |
| ----- | -------- | ----- | ----- | ----- | ------ |
| 1     | 2        | 9     | 1     | 12    | All resolved |
| 2     | 0        | 3     | 3     | 6     | All resolved |
| 3     | 0        | 0     | 3     | 3     | All resolved |
| Total | 2        | 12    | 7     | 21    | All resolved |
