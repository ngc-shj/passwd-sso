/**
 * `passwd-sso status` — Show connection and vault status.
 */

import { apiRequest } from "../lib/api-client.js";
import { isUnlocked } from "../lib/vault-state.js";
import { loadConfig } from "../lib/config.js";
import * as output from "../lib/output.js";

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  console.log(`Server: ${config.serverUrl || "(not configured)"}`);
  console.log(`Vault:  ${isUnlocked() ? "Unlocked" : "Locked"}`);

  if (!config.serverUrl) return;

  try {
    const res = await apiRequest<{ setupRequired?: boolean }>("/api/vault/status");
    if (res.ok) {
      const vaultSetup = res.data.setupRequired === false;
      console.log(`Setup:  ${vaultSetup ? "Complete" : "Required"}`);
      output.success("Connected");
    } else {
      output.error(`Server returned ${res.status}`);
    }
  } catch (err) {
    output.error(`Connection failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}
