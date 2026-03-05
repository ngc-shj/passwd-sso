#!/usr/bin/env node

/**
 * passwd-sso CLI — Password manager command-line interface.
 *
 * Long-lived process model: `unlock` enters a REPL loop where
 * commands can be executed interactively. `lock` exits the process.
 */

import { Command } from "commander";
import { createInterface } from "node:readline";
import { loginCommand } from "./commands/login.js";
import { statusCommand } from "./commands/status.js";
import { unlockCommand } from "./commands/unlock.js";
import { listCommand } from "./commands/list.js";
import { getCommand } from "./commands/get.js";
import { generateCommand } from "./commands/generate.js";
import { totpCommand } from "./commands/totp.js";
import { exportCommand } from "./commands/export.js";
import { envCommand } from "./commands/env.js";
import { runCommand } from "./commands/run.js";
import { apiKeyListCommand, apiKeyCreateCommand, apiKeyRevokeCommand } from "./commands/api-key.js";
import { agentCommand } from "./commands/agent.js";
import { isUnlocked, lockVault } from "./lib/vault-state.js";
import { clearPendingClipboard } from "./lib/clipboard.js";
import { setInsecure, clearTokenCache, startBackgroundRefresh, stopBackgroundRefresh } from "./lib/api-client.js";
import * as output from "./lib/output.js";

const program = new Command();

program
  .name("passwd-sso")
  .description("Password manager CLI")
  .version("0.1.0")
  .option("-k, --insecure", "Allow self-signed TLS certificates")
  .hook("preAction", () => {
    if (program.opts().insecure) {
      setInsecure(true);
    }
  });

program
  .command("login")
  .description("Configure server URL and authentication token")
  .action(loginCommand);

program
  .command("status")
  .description("Show connection and vault status")
  .option("--json", "Output as JSON")
  .action((opts) => statusCommand({ json: opts.json }));

program
  .command("unlock")
  .description("Unlock the vault with your master passphrase")
  .action(async () => {
    await unlockCommand();
    if (isUnlocked()) {
      await interactiveMode();
    }
  });

program
  .command("generate")
  .description("Generate a secure password")
  .option("-l, --length <n>", "Password length", "20")
  .option("--no-uppercase", "Exclude uppercase letters")
  .option("--no-digits", "Exclude digits")
  .option("--no-symbols", "Exclude symbols")
  .option("-c, --copy", "Copy to clipboard")
  .option("--json", "Output as JSON")
  .action((opts) => generateCommand({
    length: parseInt(opts.length, 10),
    noUppercase: opts.uppercase === false,
    noDigits: opts.digits === false,
    noSymbols: opts.symbols === false,
    copy: opts.copy,
    json: opts.json,
  }));

program
  .command("env")
  .description("Output vault secrets as environment variables")
  .option("-c, --config <path>", "Path to .passwd-sso-env.json")
  .option("--format <format>", "Output format: shell, dotenv, json", "shell")
  .action((opts) => envCommand({ config: opts.config, format: opts.format }));

program
  .command("run")
  .description("Inject vault secrets into a command's environment")
  .option("-c, --config <path>", "Path to .passwd-sso-env.json")
  .argument("<command...>", "Command to execute")
  .action((command: string[], opts) => runCommand({ config: opts.config, command }));

const apiKeyCmd = program
  .command("api-key")
  .description("Manage API keys");

apiKeyCmd
  .command("list")
  .description("List all API keys")
  .option("--json", "Output as JSON")
  .action((opts) => apiKeyListCommand({ json: opts.json }));

apiKeyCmd
  .command("create")
  .description("Create a new API key")
  .requiredOption("-n, --name <name>", "Key name")
  .option("-s, --scopes <scopes>", "Comma-separated scopes", "passwords:read")
  .option("-d, --days <days>", "Expiry in days", "90")
  .option("--json", "Output as JSON")
  .action((opts) => apiKeyCreateCommand({
    name: opts.name,
    scopes: opts.scopes.split(","),
    days: parseInt(opts.days, 10),
    json: opts.json,
  }));

apiKeyCmd
  .command("revoke")
  .description("Revoke an API key")
  .argument("<id>", "API key ID")
  .option("--json", "Output as JSON")
  .action((id: string, opts) => apiKeyRevokeCommand(id, { json: opts.json }));

program
  .command("agent")
  .description("Start SSH agent backed by vault SSH keys")
  .option("--eval", "Output shell eval-compatible commands")
  .action((opts) => agentCommand({ eval: opts.eval }));

program.parse();

// ─── Interactive REPL Mode ──────────────────────────────────────

async function interactiveMode(): Promise<void> {
  output.info("Vault unlocked. Type a command or `help` for options. `lock` to exit.");

  // Keep token alive during REPL session
  startBackgroundRefresh();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "passwd-sso> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const args = line.trim().split(/\s+/);
    const cmd = args[0];

    if (!cmd) {
      rl.prompt();
      continue;
    }

    try {
      switch (cmd) {
        case "list":
        case "ls":
          await listCommand({ json: args.includes("--json") });
          break;

        case "get":
          if (!args[1]) {
            output.error("Usage: get <id> [--copy] [--json] [--field <name>]");
          } else {
            const fieldIdx = args.indexOf("--field");
            const fieldArg = fieldIdx !== -1 ? args[fieldIdx + 1] : undefined;
            const field = fieldArg && !fieldArg.startsWith("-") ? fieldArg : undefined;
            if (fieldIdx !== -1 && !field) {
              output.error("Usage: get <id> --field <name>");
              break;
            }
            await getCommand(args[1], {
              copy: args.includes("--copy") || args.includes("-c"),
              json: args.includes("--json"),
              field,
            });
          }
          break;

        case "totp":
          if (!args[1]) {
            output.error("Usage: totp <id> [--copy] [--json]");
          } else {
            await totpCommand(args[1], {
              copy: args.includes("--copy") || args.includes("-c"),
              json: args.includes("--json"),
            });
          }
          break;

        case "generate":
        case "gen": {
          const lengthIdx = args.indexOf("-l");
          const lengthIdx2 = args.indexOf("--length");
          const idx = lengthIdx !== -1 ? lengthIdx : lengthIdx2;
          const rawLength = idx !== -1 ? args[idx + 1] : undefined;
          const parsedLength = rawLength && !rawLength.startsWith("-") ? parseInt(rawLength, 10) : NaN;
          if (idx !== -1 && (isNaN(parsedLength) || parsedLength <= 0)) {
            output.error("Usage: generate [-l <number>] [--copy]");
            break;
          }
          await generateCommand({
            length: isNaN(parsedLength) ? 20 : parsedLength,
            copy: args.includes("--copy") || args.includes("-c"),
            json: args.includes("--json"),
          });
          break;
        }

        case "export": {
          const fmtIdx = args.indexOf("--format");
          const outLong = args.indexOf("--output");
          const outShort = args.indexOf("-o");
          const outIdx = outLong !== -1 ? outLong : outShort;
          await exportCommand({
            format: fmtIdx !== -1 ? args[fmtIdx + 1] : "json",
            output: outIdx !== -1 ? args[outIdx + 1] : undefined,
          });
          break;
        }

        case "env": {
          const envFmtIdx = args.indexOf("--format");
          const envConfIdx = args.indexOf("-c");
          const envConfIdx2 = args.indexOf("--config");
          const envCIdx = envConfIdx !== -1 ? envConfIdx : envConfIdx2;
          await envCommand({
            config: envCIdx !== -1 ? args[envCIdx + 1] : undefined,
            format: envFmtIdx !== -1 ? args[envFmtIdx + 1] : "shell",
          });
          break;
        }

        case "api-key": {
          const sub = args[1];
          if (sub === "list") {
            await apiKeyListCommand({ json: args.includes("--json") });
          } else {
            output.error("Usage: api-key list [--json]");
          }
          break;
        }

        case "status":
          await statusCommand({ json: args.includes("--json") });
          break;

        case "lock":
        case "exit":
        case "quit":
          stopBackgroundRefresh();
          lockVault();
          clearTokenCache();
          clearPendingClipboard();
          output.success("Vault locked.");
          rl.close();
          return;

        case "help":
        case "?":
          console.log(`
Commands:
  list [--json]                    List all entries
  get <id> [--copy] [--json]       Show entry details
  get <id> --field password --copy Copy a specific field
  totp <id> [--copy] [--json]      Generate TOTP code
  generate [-l N] [--copy] [--json] Generate password
  export [--format json|csv] [-o file]  Export vault
  env [--format shell|dotenv|json] Output vault secrets as env vars
  api-key list [--json]            List API keys
  status [--json]                  Show connection status
  lock                             Lock vault and exit
          `.trim());
          break;

        default:
          output.error(`Unknown command: ${cmd}. Type 'help' for options.`);
      }
    } catch (err) {
      output.error(err instanceof Error ? err.message : "An error occurred");
    }

    rl.prompt();
  }

  // EOF (Ctrl+D) — cleanup
  stopBackgroundRefresh();
  lockVault();
  clearTokenCache();
  clearPendingClipboard();
  output.success("Vault locked.");
}
