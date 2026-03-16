-- CHECK constraints: CTAP2 spec PIN length bounds (4-63)
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_min_pin_length_check" CHECK ("min_pin_length" >= 4 AND "min_pin_length" <= 63);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_require_min_pin_length_check" CHECK ("require_min_pin_length" >= 4 AND "require_min_pin_length" <= 63);
