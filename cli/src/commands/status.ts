/**
 * `passwd-sso status` — Show connection and vault status.
 */

import { apiRequest, getTokenServerUrl } from "../lib/api-client.js";
import { isUnlocked } from "../lib/vault-state.js";
import { loadConfig } from "../lib/config.js";
import * as output from "../lib/output.js";

export async function statusCommand(options: { json?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const unlocked = isUnlocked();

  if (!config.serverUrl) {
    if (options.json) {
      output.json({ server: null, vault: unlocked ? "unlocked" : "locked", connected: false });
    } else {
      console.log(`Server: (not configured)`);
      console.log(`Vault:  ${unlocked ? "Unlocked" : "Locked"}`);
    }
    return;
  }

  // Requests go to the server that issued the stored tokens, which can differ
  // from the configured one; report the one actually contacted.
  let server = config.serverUrl;
  try {
    server = getTokenServerUrl();
  } catch {
    // not logged in — apiRequest below reports it
  }

  try {
    const res = await apiRequest<{ setupRequired?: boolean }>("/api/vault/status");
    if (res.ok) {
      const vaultSetup = res.data.setupRequired === false;
      if (options.json) {
        output.json({
          server,
          vault: unlocked ? "unlocked" : "locked",
          setup: vaultSetup ? "complete" : "required",
          connected: true,
        });
      } else {
        console.log(`Server: ${server}`);
        console.log(`Vault:  ${unlocked ? "Unlocked" : "Locked"}`);
        console.log(`Setup:  ${vaultSetup ? "Complete" : "Required"}`);
        output.success("Connected");
      }
    } else {
      if (options.json) {
        output.json({ server, vault: unlocked ? "unlocked" : "locked", connected: false, error: `HTTP ${res.status}` });
      } else {
        console.log(`Server: ${server}`);
        console.log(`Vault:  ${unlocked ? "Unlocked" : "Locked"}`);
        output.error(`Server returned ${res.status}`);
      }
    }
  } catch (err) {
    if (options.json) {
      output.json({ server, vault: unlocked ? "unlocked" : "locked", connected: false, error: err instanceof Error ? err.message : "unknown error" });
    } else {
      console.log(`Server: ${server}`);
      console.log(`Vault:  ${unlocked ? "Unlocked" : "Locked"}`);
      output.error(`Connection failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
}
