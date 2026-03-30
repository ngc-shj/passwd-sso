# Plan Review: mcp-zero-knowledge-cli-decrypt
Date: 2026-03-29
Review rounds: 3

## Round 1 Summary
Initial review. 3 Critical, 8 Major, 4 Minor findings across all experts. All reflected in plan rewrite.

## Round 2 Summary
Plan rewritten with agent daemon architecture. Key findings:
- F-6 [Major]: `use_credential` MCP tool execution model infeasible → Resolved: tool removed, Skill/hook pattern adopted
- N-1 [Critical]: Unix socket TOCTOU → Resolved: no /tmp fallback, UID verification
- N-2 [Major]: 5s auth cache bypass → Resolved: cache eliminated
- N-3 [Major]: agent_command injection → Resolved: structured args, field whitelist
- S-2 [Critical]: PSSO_PASSPHRASE → Resolved: TTY-only readPassphrase()

## Round 3 Summary (Final)
Plan findings only — no new design issues. All findings are either:
- Implementation details to add to plan (readPassphrase export, IPC key passing, etc.) → Reflected
- Code not yet implemented (expected — plan phase, not coding phase)

### Functionality Findings (Round 3)
- F-10 [Major]: `readPassphrase` unexported → Added to Step 2
- F-11 [Major]: IPC key passing undefined → Specified: stdio ipc channel + child.send()
- F-12 [Minor]: Redis compat → Added to Step 5
- F-13 [Minor]: trap EXIT caveat → Documented in Step 2
- F-14 [Minor]: SSH/decrypt agent separation → Added code structure note to Step 2

### Security Findings (Round 3)
- S3-1 [Critical]: get_credential still returns plaintext → NOT A PLAN BUG (code not yet implemented, Step 4 removes it)
- S3-2 [Major]: New scopes undefined in code → NOT A PLAN BUG (Step 1 adds them)
- S3-3 [Major]: availableTokens no scope filter → NOT A PLAN BUG (Step 5 adds it)
- S3-4 [Minor]: /delegation/check not implemented → Expected (Step 3)

### Testing Findings (Round 3)
- T-N6 [Critical]: toolGetCredential import removal → Added explicit note to Step 4-3
- T-N7 [Major]: Self-referential MCP_SCOPES test → Step 8-5 already specifies value assertions
- T-N8 [Major]: No scope-parser tests for new scopes → Step 8-6 already covers; added team-scope rejection
- T-N9 [Major]: No absence assertion in integration test → Added to Step 8-3
- T-N10 [Minor]: delegation.test.ts fixture has password → Added to Step 8-2

## Conclusion
All three experts converged to "no new design-level findings" in Round 3. Remaining items are implementation details already captured in the plan. **Plan review complete.**
