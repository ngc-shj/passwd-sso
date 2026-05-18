-- Replace mobile_bridge_codes.device_pubkey (base64url SPKI-DER, never reached production)
-- with device_jkt (RFC 7638 JWK thumbprint, 43-char base64url).
--
-- Rationale: server hashed the SPKI string and compared against the DPoP proof's
-- RFC 7638 thumbprint. These are structurally different hashes, so the cnf-binding
-- could never succeed. Pre-1.0; no production data exists for this table.
--
-- Bridge codes have a 60-second TTL — any rows present at migration time are
-- already expired (or about to expire) throwaway tokens with no recoverable
-- mapping from the dropped device_pubkey to device_jkt. Clearing them is
-- functionally equivalent to letting them expire; the iOS client will
-- simply re-authorize to obtain a fresh code.
DELETE FROM "mobile_bridge_codes";
ALTER TABLE "mobile_bridge_codes" DROP COLUMN IF EXISTS "device_pubkey";
ALTER TABLE "mobile_bridge_codes" ADD COLUMN "device_jkt" VARCHAR(43) NOT NULL;
