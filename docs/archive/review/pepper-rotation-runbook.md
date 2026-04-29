# Runbook: Verifier Pepper Rotation

**Audience**: operators with KMS / Secret Manager access and the ability to deploy new code.
**Trigger**: scheduled rotation (annual), suspected pepper compromise, KMS provider migration.
**Status**: documented. Code-level dual-version support is a prerequisite for non-disruptive rotation — see "Known gaps" below.

## What the pepper protects

The verifier pepper is an HMAC key used at the server boundary on top of the client-derived passphrase verifier hash.

```
client:  verifierHash = SHA-256(PBKDF2(passphrase, salt, 600000))   // 64-char hex
server:  passphraseVerifierHmac = HMAC-SHA256(pepper, verifierHash) // stored
         recoveryVerifierHmac   = HMAC-SHA256(pepper, recoveryVerifierHash)
         hashAccessPassword     = HMAC-SHA256(pepper, SHA-256(accessPassword))
```

If the DB is leaked but the pepper is not, an attacker cannot mount an offline dictionary attack against `passphraseVerifierHmac` — they would need to recover the pepper from the server first. The pepper turns a leaked verifier into a useless 256-bit randomness without the matching pepper.

Loss / disclosure of the pepper:
- Loss → all existing users are locked out at the server-side verifier check (HMAC will never match).
- Disclosure → DB leak now permits dictionary attack against the verifier hash; users on weak passphrases are at risk.

## Configuration map

| Component | Where | Purpose |
|---|---|---|
| `VERIFIER_PEPPER_KEY` env var | `.env`, deployed env, `EnvKeyProvider` | Source of pepper bytes for `EnvKeyProvider` |
| `KEY_PROVIDER` env var | env | Selects backend: `env` (default) / `aws-sm` / `gcp-sm` / `azure-kv` |
| KMS / Secret Manager: `verifier-pepper` | AWS Secrets Manager / GCP Secret Manager / Azure Key Vault | Source of pepper bytes for cloud providers (versioned) |
| `User.passphraseVerifierHmac` | DB, per user | The pepper-bound HMAC, stored at vault setup / change passphrase |
| `User.passphraseVerifierVersion` | DB, per user | Marker of which `VERIFIER_VERSION` the stored HMAC was computed under |
| `VERIFIER_VERSION` constant in `src/lib/crypto/crypto-client.ts` | source | Currently always set to the latest pepper version the code understands |
| `User.recoveryVerifierHmac` | DB, per user | Recovery-key path, same pepper |
| `Send.accessPasswordHash` (and similar share password fields) | DB | Pepper-bound hash of access passwords |

## Known gaps in the current code (must be addressed BEFORE a non-disruptive rotation)

The current `hmacVerifier` and `verifyPassphraseVerifier` in `src/lib/crypto/crypto-server.ts` always call `getKeyProviderSync().getKeySync("verifier-pepper")` **without a version argument** (line 245). There is no mechanism for the server to verify a stored HMAC against an older pepper while issuing new HMACs under a new pepper.

Implication: **a hot pepper change with no code-level support locks out every user** until they perform a passphrase change with their plaintext passphrase (which they cannot do because they cannot log in).

The `KeyProvider.getKeySync(name, version?)` interface already supports versions (`src/lib/key-provider/types.ts:19`); only the call sites in `crypto-server.ts` and the `User.passphraseVerifierVersion` check are not wired through.

### Minimum code change required for non-disruptive rotation (follow-up PR)

1. Plumb `version` through `hmacVerifier(verifierHash, version?)` and `verifyPassphraseVerifier(clientHash, storedHmac, storedVersion)`.
2. On verify: read `User.passphraseVerifierVersion`, fetch matching pepper version, compute HMAC with that version's pepper.
3. On write (setup / change-passphrase / rotate-key / recovery-key/recover): write with the latest pepper version and update `passphraseVerifierVersion` accordingly.
4. After verify-with-old-pepper succeeds and the request flow has the user's plaintext verifier hash (i.e., on `unlock`), **opportunistically re-HMAC under the new pepper** and persist to migrate the user transparently.

Do not run the runbook below without (1)-(3) in place. Step (4) is a nice-to-have for transparent migration and not strictly required.

## Rotation procedures

There are three modes. Pick by trigger.

### Mode A: scheduled rotation (annual) — non-disruptive

Prerequisite: code-level dual-version support (above) is deployed.

```
Day 0  : produce new pepper version in KMS, do NOT change VERIFIER_VERSION constant yet
Day 1  : deploy code that can READ both versions but still WRITES with the old version
Day 2+ : flip VERIFIER_VERSION constant to the new version, deploy
            now: writes use new pepper, reads still resolve old or new per-user
Day 3+ : on user unlock, opportunistic re-HMAC migrates the user
Month 6: count users still on old version (`SELECT COUNT(*) FROM users WHERE passphrase_verifier_version = $old`)
            decide: retire old pepper (lock out remaining stale users + recovery flow) or keep both
```

### Mode B: emergency rotation (suspected pepper disclosure) — disruptive, fast

Prerequisite: communications channel to users (email, status page).

```
T-0  : freeze writes that would re-HMAC under the compromised pepper (block setup / change-passphrase)
T+5m : produce new pepper version in KMS
T+10m: deploy code with dual-version support and VERIFIER_VERSION pointing to the new version
T+15m: announce: all users must complete passphrase verification + migration on next unlock
T+1d : monitor migration rate; users who do not migrate will be unable to verify under the old pepper
            once it is retired
T+30d: retire compromised pepper version from KMS (revoke read access)
            users still on old version → forced into recovery key flow (or re-onboarding)
```

Note: emergency mode does NOT require a passphrase change for users — the pepper is at the server boundary, not in the client KDF chain. Users keep the same passphrase; the server-side HMAC under the new pepper is recomputed during the first successful unlock that decrypts the vault correctly.

### Mode C: KMS provider migration (env → AWS / GCP / Azure)

```
Step 1: read pepper out of current provider, write it as version 1 into the new provider
Step 2: deploy with KEY_PROVIDER pointed at the new provider (no pepper byte change)
Step 3: validate by exercising sign-in for at least one user per active tenant
Step 4: on a later cycle, run Mode A using the new provider's versioning to actually rotate the bytes
```

This decomposes "switch provider" and "rotate bytes" into two steps — never combine.

## Pre-rotation checklist (apply to all modes)

- [ ] Confirm `KeyProvider.getKeySync(name, version)` is wired through `hmacVerifier` (Known gaps §1-3).
- [ ] Confirm `User.passphraseVerifierVersion` is populated for every user (`SELECT COUNT(*) FROM users WHERE passphrase_verifier_version IS NULL` should be 0).
- [ ] Confirm the audit pipeline (`audit_outbox` + chain) is healthy; rotation events must be auditable.
- [ ] Snapshot the DB before rotation (logical dump or PITR marker).
- [ ] Have a rollback plan — see "Rollback" below.

## Post-rotation verification

```sql
-- Distribution of versions (expect ~all users on the new version after Day 30+)
SELECT passphrase_verifier_version, COUNT(*) FROM users GROUP BY 1 ORDER BY 1;

-- Stale recovery verifiers (recovery_verifier_hmac is also pepper-bound)
SELECT COUNT(*) FROM users
  WHERE recovery_verifier_hmac IS NOT NULL
    AND recovery_key_set_at < NOW() - INTERVAL '30 days';

-- Audit events emitted by rotation
SELECT created_at, action, actor_user_id FROM audit_logs
  WHERE action IN ('VERIFIER_PEPPER_ROTATE_BEGIN', 'VERIFIER_PEPPER_ROTATE_COMPLETE')
  ORDER BY created_at DESC LIMIT 20;
```

(Audit actions above do not yet exist in `src/lib/constants/audit.ts` — add them when implementing the code-level rotation support.)

## Rollback

If the new pepper is wrong or rotation breaks unlock for a measurable percentage of users:

1. Re-deploy code with `VERIFIER_VERSION` pointing back at the old version (the code must still hold dual-version support so it can verify users who already migrated).
2. Do NOT retire the old pepper until the rollback is confirmed working.
3. Audit-log the rollback (`VERIFIER_PEPPER_ROTATE_ROLLBACK`).
4. Run the version distribution query above; users who already migrated will need a second migration to the old version (or, if rollback is brief, leave them on the new version and accept dual-version reads indefinitely).

## Automation (skeleton — not yet implemented)

A `scripts/rotate-verifier-pepper.sh` should:

1. Read current `VERIFIER_VERSION` from source (`grep -E '^export const VERIFIER_VERSION' src/lib/crypto/crypto-client.ts`).
2. Validate that the dual-version code path exists (presence check on `getKeySync(.+, version)` in `src/lib/crypto/crypto-server.ts`).
3. Print the SQL distribution query for operator review.
4. Open a draft PR that bumps `VERIFIER_VERSION` and documents the rotation in a release note.

Implementation of this script is tracked separately — see follow-up issue.

## Open follow-ups

- [ ] Implement code-level dual-version pepper support (`hmacVerifier(verifierHash, version)`, `verifyPassphraseVerifier(_, _, storedVersion)`, opportunistic re-HMAC on unlock).
- [ ] Add `VERIFIER_PEPPER_ROTATE_*` audit actions to `src/lib/constants/audit.ts`.
- [ ] Implement `scripts/rotate-verifier-pepper.sh` per "Automation" section.
- [ ] Add an integration test that exercises Mode A with two pepper versions side-by-side and asserts both verify correctly.
- [ ] Document operator-facing rotation in the customer/security-disclosure channel (out of repo).

## References

- `src/lib/crypto/crypto-server.ts:233-291` — current pepper / HMAC implementation.
- `src/lib/key-provider/types.ts:19` — `getKeySync(name, version?)` interface (already versioned).
- `prisma/schema.prisma` `User.passphraseVerifierVersion`, `User.recoveryVerifierHmac` — per-user version marker.
- `src/app/api/vault/change-passphrase/route.ts:79` — version mismatch gate.
