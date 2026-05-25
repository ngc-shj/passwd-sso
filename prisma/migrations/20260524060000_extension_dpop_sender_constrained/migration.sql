-- Migration: extension_dpop_sender_constrained
-- Goal: enforce sender-constrained DPoP for browser-extension tokens.
--
-- TRUNCATE note: extension_bridge_codes rows have a 60s TTL; truncating
-- mid-deploy discards at most 60s of in-flight handshakes. Users see "code
-- expired" once and retry. This repo does NOT use logical replication, so
-- the publication-truncate-flag caveat (pg docs) does not apply.

-- Step 1: TRUNCATE in-flight bridge codes (60s TTL; data loss negligible).
TRUNCATE TABLE extension_bridge_codes;

-- Step 2: Delete legacy BROWSER_EXTENSION ExtensionToken rows (cnfJkt-null).
-- IOS_APP rows are spared regardless of cnfJkt (some pre-iOS-DPoP rows may
-- have null cnf_jkt; they are rejected at validate time, not here).
DELETE FROM extension_tokens
  WHERE client_kind = 'BROWSER_EXTENSION' AND cnf_jkt IS NULL;

-- Step 3: Add NOT NULL cnf_jkt column to extension_bridge_codes.
-- No backfill needed: Step 1 emptied the table.
ALTER TABLE "extension_bridge_codes"
  ADD COLUMN "cnf_jkt" VARCHAR(64) NOT NULL;

-- Step 4: Enforce schema-level invariant on extension_tokens for
-- BROWSER_EXTENSION rows. Cannot use a column-level NOT NULL because
-- IOS_APP rows historically may have null cnf_jkt.
-- CHECK constraint: BROWSER_EXTENSION rows MUST have a non-null cnf_jkt.
ALTER TABLE extension_tokens
  ADD CONSTRAINT extension_tokens_cnf_jkt_required_for_browser_ext
  CHECK (client_kind <> 'BROWSER_EXTENSION' OR cnf_jkt IS NOT NULL);

-- No index on cnf_jkt: query path uses token_hash / code_hash unique indexes;
-- cnf_jkt is read after that hit, never queried independently.
