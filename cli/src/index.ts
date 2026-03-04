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
  .action(statusCommand);

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
  .action((opts) => generateCommand({
    length: parseInt(opts.length, 10),
    noUppercase: opts.uppercase === false,
    noDigits: opts.digits === false,
    noSymbols: opts.symbols === false,
    copy: opts.copy,
  }));

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
            output.error("Usage: totp <id> [--copy]");
          } else {
            await totpCommand(args[1], {
              copy: args.includes("--copy") || args.includes("-c"),
            });
          }
          break;

        case "generate":
        case "gen": {
          const lengthIdx = args.indexOf("-l");
          const lengthIdx2 = args.indexOf("--length");
          const idx = lengthIdx !== -1 ? lengthIdx : lengthIdx2;
          await generateCommand({
            length: idx !== -1 ? parseInt(args[idx + 1], 10) : 20,
            copy: args.includes("--copy") || args.includes("-c"),
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

        case "status":
          await statusCommand();
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
  totp <id> [--copy]               Generate TOTP code
  generate [-l N] [--copy]         Generate password
  export [--format json|csv] [-o file]  Export vault
  status                           Show connection status
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
