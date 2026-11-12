# Coding Deviation Log: team-lock-busy-error

- D1 (C7) — `parseJsonBodyOnce` is exported and also added to `cli/src/lib/api-error-body.ts` and
  `extension/src/lib/api-error-body.ts`. The plan placed the memo in the main reader only, but
  `scripts/checks/check-api-error-body-drift.sh` requires the three copies to match after
  normalization, and the CLI/extension readers have the same single-read hazard. The `WeakMap`
  is declared after the function in all three because the drift normalizer drops everything
  before a file's first `export`. The plan called the parser module-private; it is exported because
  `toastApiError` (another module) reads through it.
