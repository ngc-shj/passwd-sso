# Plan Review: mcp-zero-knowledge-cli-decrypt
Date: 2026-03-29
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Major]: `hasDecryptScope` filter in delegation GET handler rejects new scopes
- `delegation/route.ts` GET handler computes `hasDecryptScope` by checking for `"credentials:decrypt"` only (L310)
- `create-delegation-dialog.tsx` filters tokens by `hasDecryptScope === true` (L86)
- Tokens with `credentials:list` / `credentials:read` won't appear in delegation dialog
- **Recommended**: Update filter to accept new scopes; rename property to `hasDelegationScope`

### F-2 [Major]: Delegation POST handler scope validation rejects new scopes
- POST handler (L113-118) checks `scopes.includes(MCP_SCOPE.CREDENTIALS_DECRYPT)` only
- Tokens with new scopes (`credentials:list + credentials:read`) will get 403
- **Recommended**: Accept `credentials:list` OR legacy `credentials:decrypt` for delegation creation

### F-3 [Major]: `get_credential_encrypted` UUID-only validation conflicts with CUID v1 entry IDs
- Existing `getCredentialSchema` uses `z.string().uuid()` (tools.ts L80-82)
- Memory `project_cuid_uuid_inconsistency.md` documents mixed CUID v1 / UUIDv4 entry IDs
- CUID v1 entries would be rejected by UUID validation
- **Recommended**: Use `z.string().min(1).max(100)` or match existing `get` command validation

### F-4 [Minor]: CLI `decrypt` missing from REPL interactive mode
- `interactiveMode()` in `cli/src/index.ts` (L140-301) uses explicit switch for commands
- `decrypt` command not listed in REPL switch cases
- **Recommended**: Add `decrypt` to both top-level and REPL command registration

### F-5 [Minor]: Existing negative test for `credentials:read` in scope-parser.test.ts will break
- L201-204 tests `parseScope("credentials:read")` returns null
- Adding `credentials:read` to allowlist makes this test fail
- **Recommended**: Explicitly note in Step 1 which test lines to delete/invert

## Security Findings

### S-1 [Critical]: `get_credential_encrypted` session lookup implementation insufficiently specified — IDOR risk
- Plan says "verify entryId in DelegationSession.entryIds" but doesn't specify which session
- Must use `findActiveDelegationSession(token.userId!, token.tokenId)` — not userId-only query
- Future implementer could query by userId alone, crossing session boundaries
- **Recommended**: Explicitly specify `findActiveDelegationSession(token.userId!, token.tokenId)` in Step 4-5
- escalate: false

### S-2 [Critical]: `PSSO_PASSPHRASE` environment variable exposes master passphrase in hook workflow
- Plan promotes `PSSO_PASSPHRASE` as standard hook pattern for auto-unlock
- `/proc/<pid>/environ` readable by same-user processes; crash dumps may capture env vars
- Master passphrase compromise = full vault decryption
- **Recommended**: Add warnings against persistent env var; recommend `pass`/`1password CLI` injection; consider `--passphrase-fd` option
- escalate: true (master passphrase exposure defeats entire zero-knowledge architecture)

### S-3 [Major]: Rate limit key `userId` causes cross-client DoS
- 10 req/min per userId means malicious client A exhausts quota for client B
- **Recommended**: Use composite key `${userId}:${clientId}` with per-tenant upper bound

### S-4 [Major]: Legacy scope expansion timing undefined — consent UI may misrepresent permissions
- If expansion happens at tool-call time (not token issuance), consent UI shows `credentials:decrypt` but user doesn't know it includes `credentials:read`
- OWASP A04 (Insecure Design)
- **Recommended**: Expand at consent/token-issuance time; store expanded scopes in DB; define migration for existing tokens

### S-5 [Major]: CLI `decrypt` should verify response entryId matches requested id
- MitM or bug could substitute entryId in response
- AES-GCM authTag would catch this, but explicit check adds defense-in-depth
- **Recommended**: Add id match verification to decrypt command spec

### S-6 [Minor]: `username` PII exposed in `list_credentials` to LLM
- username often contains email addresses; data minimization concern
- **Recommended**: Note as future improvement — opt-in username sharing

## Testing Findings

### T-1 [Critical]: No specific test cases defined for `get_credential_encrypted` authorization boundary
- Integration test `mcp-oauth-flow.test.ts` Scenario 5 tests old `get_credential`
- Need explicit test cases: authorized entry, unauthorized entry, wrong scope, legacy scope expansion
- **Recommended**: Add 4+ test cases to Step 7 specification

### T-2 [Critical]: Existing negative test `credentials:read` in scope-parser.test.ts will break
- Same as F-5; from testing perspective this is Critical because CI will fail
- **Recommended**: Specify exact lines to delete/invert in Step 1

### T-3 [Major]: `MCP_SCOPES` array membership ambiguity for legacy `CREDENTIALS_DECRYPT`
- `mcp.test.ts` validates `MCP_SCOPES` contents; unclear if legacy scope stays in `MCP_SCOPE` object
- **Recommended**: Explicitly state whether `CREDENTIALS_DECRYPT` remains in `MCP_SCOPE` and `MCP_SCOPES`

### T-4 [Major]: CLI `decrypt` test cases missing aadVersion branching and error paths
- Need: aadVersion=0 (no AAD), aadVersion>=1 (with AAD), decrypt failure, unknown field
- Need: vault-state mock reset in beforeEach
- **Recommended**: Add these cases to Step 2 test specification

### T-5 [Major]: `tools.test.ts` mock fixtures include password/notes but plan removes them from response
- `ENTRY_1`/`ENTRY_2` fixtures contain `password`, `url`, `notes`
- After change, list/search must NOT return these fields
- Tests must assert `not.toHaveProperty("password")` etc.
- **Recommended**: Add absence assertions to Step 7 specification

### T-6 [Major]: Integration test `makeClient` fixture uses hardcoded `credentials:decrypt`
- L155-165 hardcodes `allowedScopes: "credentials:decrypt"`
- Need variant fixtures with new scopes for integration testing
- **Recommended**: Add fixture variants and legacy expansion scenario to Step 7

### T-7 [Minor]: Test files hardcode scope strings instead of importing from `MCP_SCOPE`
- `consent/route.test.ts` L78, L111; `mcp-oauth-flow.test.ts` L162
- **Recommended**: Import from `MCP_SCOPE` constants (RT3 compliance)

## Adjacent Findings

### [Adjacent-Sec→Func] S-7 [Major]: Metadata-only delegation still sends username/urlHost as plaintext browser→server
- Option C preserves browser→server plaintext path for metadata
- Architecture choice between Option A (no server metadata) vs Option C (metadata on server)
- This is an inherent trade-off of the chosen approach, not a bug

## Quality Warnings
None flagged by local LLM merge.
