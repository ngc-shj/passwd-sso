-- C19 / OWASP A04-5: break-glass cooling-off period column.
-- NULL = legacy/immediate (backfill safe). When set in the future, access
-- checks at the call sites of personal_log_access_grants must filter
-- (effective_at IS NULL OR effective_at <= now()).
ALTER TABLE "personal_log_access_grants"
  ADD COLUMN "effective_at" TIMESTAMPTZ(3) NULL;
