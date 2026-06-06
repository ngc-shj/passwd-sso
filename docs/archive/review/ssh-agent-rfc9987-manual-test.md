# Manual Test Plan: ssh-agent-rfc9987 (Tier-1 — CLI daemon)

Covers only the paths automated tests cannot exercise (two-filter rule): the live OpenSSH
handshake (VC1), the live server authorize + audit round-trip (VC3), and the real-TTY
confirmation prompt (VC4). Everything else is covered by unit tests.

## Pre-conditions

- A running passwd-sso server (dev) with the `20260607000000_add_ssh_key_sign_audit_actions` migration applied.
- A CLI logged in AFTER this change (so the token carries `ssh:sign`): `passwd-sso login`.
- At least one `SSH_KEY` vault entry with a usable private/public key (e.g. an ed25519 keypair).
- `ssh` / `ssh-add` (OpenSSH client) available.
- Substitute `<test-user-email>` / `<your-host>` locally — do not commit real values.

## Steps & Expected results

### 1. Identities + live signature (VC1, VC3)
> NOTE: `passwd-sso agent` runs in the FOREGROUND (it does not fork/detach — unlike
> the decrypt agent). Do NOT use `eval $(passwd-sso agent --eval)` — it hangs because
> the process never exits. Use the two-terminal procedure below.
1. Terminal 1: `passwd-sso agent` → prints the socket path and stays running.
2. Terminal 2: `export SSH_AUTH_SOCK=<printed socket path>`.
3. `ssh-add -l` → **Expected**: lists the vault SSH key fingerprint(s) (REQUEST_IDENTITIES).
3. `ssh -T git@github.com` (or any host trusting the key) →
   - **Expected**: OpenSSH sends `session-bind@openssh.com` (verified locally), then SIGN_REQUEST;
     the agent calls `POST /api/vault/ssh/sign-authorize`, signs locally, auth succeeds.
   - **Expected (audit)**: a personal audit row `SSH_KEY_SIGN` appears (actorType `MCP_AGENT`)
     with metadata `{ fingerprint, host: { hostKeyFingerprint, forwarded:false } }`.

### 2. Immediate revocation (VC3)
1. In the web UI, archive (or trash) the SSH_KEY entry.
2. Re-run `ssh -T ...` with the same agent still running →
   - **Expected**: signing is denied (`entry_not_found` → SSH_AGENT_FAILURE); ssh falls through / fails.
   - **Expected (audit)**: an `SSH_KEY_SIGN_DENIED` row is recorded.
3. Un-archive to restore.

### 3. requireReprompt confirmation (VC4)
1. Set `requireReprompt = true` on the SSH_KEY entry in the web UI.
2. Run the agent in the FOREGROUND: `passwd-sso agent` (not `--eval`), in another shell `export SSH_AUTH_SOCK=<printed socket>`.
3. `ssh -T ...` → **Expected**: the foreground agent prompts `Allow SSH signing with "<label>"? [y/N]` on its TTY; `y` → signs; `n` → SSH_AGENT_FAILURE.
4. Detached mode (`eval $(passwd-sso agent --eval)`) with the same requireReprompt key → **Expected**: signing denied (no TTY, fail-closed) with a logged hint.

### 4. Stale-token re-login hint (VC3)
1. Using a CLI token minted BEFORE this change (no `ssh:sign` scope), run the agent and `ssh -T ...` →
   - **Expected**: deny + a one-time stderr hint "Re-run `passwd-sso login` to grant SSH signing (ssh:sign scope)."

### 5. ssh-add -D (REMOVE_ALL_IDENTITIES)
1. `ssh-add -D` → **Expected**: SUCCESS; `ssh-add -l` shows no identities until agent restart.

## Rollback
- Stop the agent (Ctrl-C / kill the pid); `unset SSH_AUTH_SOCK`.
- The migration is additive (enum values only); no data rollback needed. To remove the feature, revert the branch.

## Actual results (2026-06-07, local dev, operator: repo owner)
- §1 `ssh-add -l` → vault key listed (REQUEST_IDENTITIES) ✓
- Core SIGN path verified via `ssh-keygen -Y sign -f <agent.pub> -n test <file>` (exercises SIGN_REQUEST → server authorize → local sign without needing GitHub): `Write signature to …sig` ✓
- Audit (audit_outbox): `SSH_KEY_SIGN` / actorType `MCP_AGENT` / metadata `{"fingerprint":"SHA256:…"}` ✓ (`host` null — `ssh-keygen -Y sign` sends no session-bind, expected). `MCP_CONSENT_GRANT` shows the token carries `ssh:sign`.
- **Bug found + fixed during this verification**: `/api/vault/ssh/sign-authorize` was missing from the proxy Bearer-bypass list (`EXTENSION_TOKEN_ROUTES`), so the CLI Bearer call was 401'd by the proxy before reaching the handler. Fixed in `fix(proxy): register ssh sign-authorize as a Bearer-bypass route` + cors-gate regression test. Route unit tests mock `authOrToken` and never traverse the proxy, so this only surfaced in live verification.
- Still `blocked-deferred`: live `ssh -T` session-bind path (VC1 — requires the vault key registered on a real host) and the requireReprompt real-TTY prompt (VC4). Core authorize+audit (VC3) now `verified-local`.

## Notes
- Per-sign authorize adds one HTTP round-trip per signature; if the server is unreachable, signing fails closed (ssh cannot authenticate) — expected behavior of the audited model.
- `host`/`fingerprint` in audit metadata are client-asserted (server cannot re-derive them under E2E); for the honest agent they are accurate because session-bind is verified locally.
