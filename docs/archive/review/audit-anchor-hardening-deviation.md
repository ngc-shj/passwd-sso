# Coding Deviation Log: audit-anchor-hardening

## Batch A (C1, C2)

- **D1 — S3 `read` costs a one-key LIST plus the GET.** C1 says absence is decided from a
  listing, never a GET status; `read` therefore lists the exact key (`Prefix` = the full key,
  `MaxKeys: 1`) before the GET. The plan's "one LIST and one GET per step" undercounts by one
  LIST per read. The key starts with `<prefix>/`, so it satisfies C5's `s3:prefix` condition;
  C5's test covers this form too.
- **D2 — a GitHub 422 is classified by lookup, not by its body.** A 422 counts as a taken name
  only when an asset of that name exists in the release; otherwise it throws. The body shape
  is unverified (E2).
- **D3 — `create` enforces `AUDIT_ANCHOR_ARTIFACT_MAX_BYTES` too**, so nothing is stored that
  `read` would refuse.
- **D4 — `readJwsKid` throws `InvalidSignatureError` for a JWS with no readable header**
  (`InvalidKidError` for a missing or malformed kid), as `verify` and the CLI do.
- **D5 — additions to C2's signatures:** `verifyStatement`, `InvalidPublicKeyError`, an explicit
  32-byte check on seeds and public keys; CLI `InsecureUrlError`, `InvalidPublicKeyError`,
  `PriorPublicKeyRequiredError` (exit 1).
- **D6 — the URL vectors are CLI-only** (the server has no URL rule). The upper-case-scheme
  deny matches the scheme on the raw text, because `new URL` lower-cases it.
- **D7 — filesystem `list` skips `.tmp-*` names** (a crashed create's leftover); the temp file
  is fsynced before `link()`.
- **D8 — `in-memory-destination.ts` lives under `src/lib/audit/anchor-destinations/`** (test
  support imported by unit and integration suites); the shared contract suite and the fake
  GitHub server are under `src/__tests__/helpers/`.
- **D9 — the hanging-`list`/`create` token cases moved to C4**: the `<name>_READ_FAILED` /
  `_UPLOAD_FAILED` tokens are formed by the publisher.
- **D10 — T3-6 (gitleaks on the vector file):** the fixture path is under the repository's
  `(^|/)__tests__/` gitleaks allowlist, so a scan skips it; the seed is the low-entropy
  `0x42 × 32` constant regardless.
- **D11 — one guard without its own reddening test:** the inner "refusing to delete an
  uploaded asset" check in `deleteAssetReservation` is unreachable while the outer re-read
  guard exists (defence in depth; the outer guard is red-proven).
