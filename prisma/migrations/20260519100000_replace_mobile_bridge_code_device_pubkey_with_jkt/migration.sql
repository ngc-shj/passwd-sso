-- Replace mobile_bridge_codes.device_pubkey (base64url SPKI-DER, never reached production)
-- with device_jkt (RFC 7638 JWK thumbprint, 43-char base64url).
--
-- Rationale: server hashed the SPKI string and compared against the DPoP proof's
-- RFC 7638 thumbprint. These are structurally different hashes, so the cnf-binding
-- could never succeed. Pre-1.0; no production data exists for this table.

ALTER TABLE "mobile_bridge_codes" DROP COLUMN "device_pubkey";
ALTER TABLE "mobile_bridge_codes" ADD COLUMN "device_jkt" VARCHAR(43) NOT NULL;
