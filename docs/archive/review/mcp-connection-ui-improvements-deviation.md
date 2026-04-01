# Coding Deviation Log: mcp-connection-ui-improvements
Created: 2026-04-01

## Deviations from Plan

### DEV-1: Audit log written inside transaction instead of post-commit via logAudit
- **Plan description**: The plan describes the audit entry for `MCP_CONNECTION_REVOKE_ALL` as a post-transaction step, consistent with the `SESSION_REVOKE_ALL` pattern where `logAudit` is called after the transaction commits.
- **Actual implementation**: `tx.auditLog.create` is called inside the `$transaction` block in `src/app/api/user/mcp-tokens/route.ts`. The audit entry is written atomically with the token revocations.
- **Reason**: Writing the audit entry inside the transaction ensures that if the DB write fails mid-transaction and rolls back, no audit entry is created for an operation that did not complete. This is strictly stronger than the post-commit pattern — it eliminates the race window where tokens are revoked but the audit entry is lost due to a subsequent failure.
- **Impact scope**: `src/app/api/user/mcp-tokens/route.ts` (DELETE handler). Audit entries for `MCP_CONNECTION_REVOKE_ALL` are guaranteed to exist if and only if the revocation completed. No functional regression; behavior is strictly safer.

### DEV-2: Per-token revoke logic not extracted into a shared helper
- **Plan description**: "Consider extracting the per-token revoke logic (refresh family + delegation session + Redis eviction) into a shared helper function that both the single-revoke `[id]/route.ts` and bulk-revoke endpoint can use."
- **Actual implementation**: No shared helper was created. The bulk revoke handler in `src/app/api/user/mcp-tokens/route.ts` contains its own inline implementation of the refresh-family revocation and delegation-session revocation logic. The single-revoke handler in `src/app/api/user/mcp-tokens/[id]/route.ts` retains its own separate implementation.
- **Reason**: The plan used "Consider" language, marking this as optional. The bulk revoke operates on sets of token IDs (batch `updateMany`) while the single-revoke operates on one token at a time inside a transaction; the structural difference makes a direct shared helper awkward without additional abstraction. The `userId` defense-in-depth fix in `[id]/route.ts` was applied unconditionally as planned.
- **Impact scope**: `src/app/api/user/mcp-tokens/route.ts` and `src/app/api/user/mcp-tokens/[id]/route.ts` contain parallel but non-shared revocation logic. Risk: future changes to revocation behavior must be applied to both files independently.
