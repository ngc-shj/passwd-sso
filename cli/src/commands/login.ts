/**
 * `passwd-sso login` — Configure server URL and Bearer token.
 */

import { createInterface } from "node:readline";
import { loadConfig, saveConfig, saveToken } from "../lib/config.js";
import { setTokenCache } from "../lib/api-client.js";
import * as output from "../lib/output.js";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function loginCommand(): Promise<void> {
  const config = loadConfig();

  const serverUrl = await prompt(
    `Server URL${config.serverUrl ? ` [${config.serverUrl}]` : ""}: `,
  );
  if (serverUrl) {
    config.serverUrl = serverUrl.replace(/\/$/, "");
  }
  if (!config.serverUrl) {
    output.error("Server URL is required.");
    return;
  }

  output.info(
    "Open your browser and go to the token page to generate a CLI token.",
  );
  output.info(`  ${config.serverUrl}/dashboard/settings`);
  console.log();

  const token = await prompt("Paste your token: ");
  if (!token) {
    output.error("Token is required.");
    return;
  }

  saveConfig(config);
  const storage = await saveToken(token);
  setTokenCache(token);

  if (storage === "file") {
    output.warn("Token saved to file (plaintext). Consider installing keytar for OS keychain storage.");
  }

  output.success(`Logged in to ${config.serverUrl}`);
}
