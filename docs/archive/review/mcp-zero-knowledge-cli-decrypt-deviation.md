# Coding Deviation Log: mcp-zero-knowledge-cli-decrypt
Created: 2026-03-29

## Deviations from Plan

### D1: `--eval` flag implemented with fork + IPC
- **Plan description**: `--eval` flag daemonizes the agent (fork + detach + IPC key passing)
- **Actual implementation**: Implemented as planned. Parent prompts for passphrase, unlocks vault, forks detached child with IPC channel, sends vault key hex to child, child acknowledges "ready", parent outputs `PSSO_AGENT_SOCK`, `PSSO_AGENT_PID`, `trap EXIT` and exits.
- **No deviation** — implemented as planned.

### D2: CLI agent/decrypt unit tests deferred
- **Plan description**: Step 2-5 and Step 8-7/8-8 specify `agent-decrypt.test.ts` and `decrypt-client.test.ts`
- **Actual implementation**: Not created in this PR. Endpoint tests (`check/route.test.ts`) and integration tests are present.
- **Reason**: PR scope is already large (30+ files). CLI socket tests require Unix socket mocking infrastructure that doesn't exist yet. Integration test via the server-side check endpoint covers the authorization critical path.
- **Impact scope**: Agent-side logic (socket handling, AAD branching, field whitelist) is untested. Follow-up PR tracked.

### D3: `check/route.ts` uses single-query instead of `findActiveDelegationSession` + `getSessionEntryIds`
- **Plan description**: Step 3 uses `findActiveDelegationSession()` then separately fetches entryIds
- **Actual implementation**: Single `prisma.delegationSession.findFirst()` with `select: { id, expiresAt, entryIds }` — eliminates TOCTOU window
- **Reason**: Security review (Sec-M1) identified 2-query approach as having a TOCTOU race condition. Single query is both safer and more performant.
- **Impact scope**: Positive deviation — strictly better than planned approach.

---
