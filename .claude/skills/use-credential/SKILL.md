---
name: use-credential
description: "Use a vault credential to execute a command without exposing the password to the AI. Decrypts via the local agent and pipes the credential directly into the target command. Use this skill when: asked to login to a service; asked to use a password from the vault; asked to authenticate with stored credentials."
---

# Use Credential Skill

Executes a command using a vault credential. The password never appears in the conversation context — it is consumed inside a subshell and piped directly to the target command.

**Prerequisites:**
- Decrypt agent running: `eval $(npx tsx ~/ghq/github.com/ngc-shj/passwd-sso/cli/src/index.ts agent --decrypt --eval)`
- `$PSSO_AGENT_SOCK` environment variable set
- Active delegation session (create via vault UI)

---

## Step 1: Identify the Credential

Call `list_credentials` MCP tool to find the entry. Note the `id` and `username`.

If no delegation session is active, instruct the user:
> Please create a delegation session in the vault UI (Settings > Delegation > New Delegation), then try again.

---

## Step 2: Identify the MCP Client ID

The MCP client ID (`mcpc_xxx`) is needed for authorization. This is the public client identifier from the OAuth registration — NOT an internal token UUID.

To find it, check the MCP server connection config or the delegation UI in the browser. The client ID is stable across token refreshes.

---

## Step 3: Execute with Credential

Generate and execute a **subshell command** that:
1. Decrypts the credential inside a subshell
2. Uses it in the target command
3. Returns only the result

**CRITICAL RULES:**
- NEVER run `passwd-sso decrypt` or equivalent commands where stdout is visible to this conversation
- ALWAYS wrap in a subshell pattern that suppresses credential output
- NEVER use `echo`, `cat`, `printf` or any command that would display the credential value
- NEVER store the credential in a variable outside the subshell

### Pattern A: curl with Basic Auth

```bash
(
  _CRED=$(PSSO_AGENT_SOCK="${PSSO_AGENT_SOCK}" npx tsx ~/ghq/github.com/ngc-shj/passwd-sso/cli/src/index.ts decrypt ENTRY_ID --field password --mcp-client MCP_CLIENT_ID)
  curl -s -u "USERNAME:${_CRED}" TARGET_URL
  echo "exit:$?"
) 2>/dev/null
```

### Pattern B: curl with Bearer Token

```bash
(
  _CRED=$(PSSO_AGENT_SOCK="${PSSO_AGENT_SOCK}" npx tsx ~/ghq/github.com/ngc-shj/passwd-sso/cli/src/index.ts decrypt ENTRY_ID --field password --mcp-client MCP_CLIENT_ID)
  curl -s -H "Authorization: Bearer ${_CRED}" TARGET_URL
  echo "exit:$?"
) 2>/dev/null
```

### Pattern C: Generic Command

```bash
(
  _CRED=$(PSSO_AGENT_SOCK="${PSSO_AGENT_SOCK}" npx tsx ~/ghq/github.com/ngc-shj/passwd-sso/cli/src/index.ts decrypt ENTRY_ID --field password --mcp-client MCP_CLIENT_ID)
  COMMAND_USING_CRED
  echo "exit:$?"
) 2>/dev/null
```

### Pattern D: Clipboard Copy (macOS)

```bash
(
  PSSO_AGENT_SOCK="${PSSO_AGENT_SOCK}" npx tsx ~/ghq/github.com/ngc-shj/passwd-sso/cli/src/index.ts decrypt ENTRY_ID --field password --mcp-client MCP_CLIENT_ID | pbcopy
  echo "Copied to clipboard"
) 2>/dev/null
```

### Pattern E: Clipboard Copy (Linux)

```bash
(
  PSSO_AGENT_SOCK="${PSSO_AGENT_SOCK}" npx tsx ~/ghq/github.com/ngc-shj/passwd-sso/cli/src/index.ts decrypt ENTRY_ID --field password --mcp-client MCP_CLIENT_ID | xclip -selection clipboard
  echo "Copied to clipboard"
) 2>/dev/null
```

Replace:
- `ENTRY_ID` — entry UUID from `list_credentials`
- `MCP_CLIENT_ID` — MCP client ID (mcpc_xxx) for authorization
- `USERNAME` — username from `list_credentials`
- `TARGET_URL` — the URL to authenticate against
- `COMMAND_USING_CRED` — any command that uses `${_CRED}`

---

## Step 4: Report Result

Report only the command's output (e.g., HTTP status, success/failure). NEVER report the credential value itself.

If the command fails, report the error and suggest troubleshooting steps:
- Agent not running → "Start the agent with `eval $(passwd-sso agent --decrypt --eval)`"
- Entry not delegated → "Add this entry to the delegation session in the vault UI"
- Session expired → "Create a new delegation session in the vault UI"
