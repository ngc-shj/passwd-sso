-- H4 (2026-07 review): Session.session_token now stores a domain-separated
-- HMAC-SHA-256 DIGEST of the cookie token, never the raw token. Existing rows
-- hold raw plaintext tokens that (a) can never match the new digest-based
-- lookup, so they are dead, and (b) are the exact reusable-token liability this
-- change removes. Purge them so no plaintext session token survives the upgrade;
-- every user simply re-authenticates. No schema change — the column stays TEXT.
DELETE FROM "sessions";
