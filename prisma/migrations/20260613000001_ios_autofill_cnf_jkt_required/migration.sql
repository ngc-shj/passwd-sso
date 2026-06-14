-- DPoP sender-constraint, DB-layer parity with BROWSER_EXTENSION: every
-- IOS_AUTOFILL row MUST carry a non-null cnf_jkt. issueAutofillToken always
-- sets it (the TS parameter is non-nullable), and validateExtensionToken
-- rejects a null-cnf_jkt row at runtime — this constraint makes the invariant
-- enforceable at the storage layer too, so a future code bug or a direct
-- privileged write cannot create a non-sender-constrained IOS_AUTOFILL token.
-- Separate migration from the ADD VALUE: Postgres forbids referencing a
-- newly-added enum value in the same transaction that added it.
ALTER TABLE extension_tokens
  ADD CONSTRAINT extension_tokens_cnf_jkt_required_for_ios_autofill
  CHECK (client_kind <> 'IOS_AUTOFILL' OR cnf_jkt IS NOT NULL);
