# Manual Test Scripts

End-to-end verification scripts for features that are hard to cover with unit
or integration tests alone. Each script:

- Sets up a minimal fixture in the running dev DB (bypassing RLS)
- Calls the actual HTTP API on the running dev server
- Inspects DB state to verify expected side effects
- Cleans up the fixture on exit

These are **not** run by CI. They are one-shot verification tools for
reviewers to confirm behavior against a live stack.

## Prerequisites

- Dev server running at `https://localhost:3001/passwd-sso` (`npm run dev`)
- PostgreSQL container running (`docker compose up -d db`)
- `.env.local` populated with `DATABASE_URL`, `VERIFIER_PEPPER_KEY`,
  `VAULT_MASTER_KEY_*`
- At least one `PasswordEntry` row exists in the DB

## How to run

```bash
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
  scripts/manual-tests/<script-name>.ts
```

## Scripts

| Script | Verifies |
|--------|----------|
| `share-access-audit.ts` | Anonymous share-link access writes `audit_logs` directly (userId=NULL, actor_type=SYSTEM) and does **not** enter the outbox |
