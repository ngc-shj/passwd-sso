-- A02-8: per-credential PRF salt for WebAuthn-bound vault key wrapping.
-- NULL = legacy v1 (RP-global salt); non-NULL = v2 (HKDF with per-cred salt).
-- Immutable after INSERT (enforced by application code + pre-pr.sh grep guard).
ALTER TABLE "webauthn_credentials" ADD COLUMN "prf_salt" VARCHAR(64);
