/**
 * `passwd-sso api-key` — Manage API keys.
 *
 * Subcommands:
 *   list   — List API keys
 *   create — Create a new API key
 *   revoke — Revoke an API key
 */

import { apiRequest } from "../lib/api-client.js";
import * as output from "../lib/output.js";

interface ApiKeyEntry {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export async function apiKeyListCommand(): Promise<void> {
  const res = await apiRequest<ApiKeyEntry[]>("/api/api-keys");
  if (!res.ok) {
    output.error(`Failed to list API keys: HTTP ${res.status}`);
    return;
  }

  const keys = res.data;
  if (keys.length === 0) {
    output.info("No API keys found.");
    return;
  }

  const rows: string[][] = [];
  for (const key of keys) {
    const status = key.revokedAt
      ? "revoked"
      : new Date(key.expiresAt) < new Date()
        ? "expired"
        : "active";
    rows.push([
      key.name,
      key.prefix + "...",
      key.scopes.join(", "),
      status,
      new Date(key.expiresAt).toLocaleDateString(),
      key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "never",
    ]);
  }
  output.table(["Name", "Prefix", "Scopes", "Status", "Expires", "Last Used"], rows);
}

interface CreateOptions {
  name: string;
  scopes: string[];
  days: number;
}

export async function apiKeyCreateCommand(opts: CreateOptions): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + opts.days);

  const res = await apiRequest<{
    id: string;
    token: string;
    prefix: string;
    name: string;
    scopes: string[];
    expiresAt: string;
  }>("/api/api-keys", {
    method: "POST",
    body: {
      name: opts.name,
      scope: opts.scopes,
      expiresAt: expiresAt.toISOString(),
    },
  });

  if (!res.ok) {
    const err = res.data as { error?: string };
    output.error(`Failed to create API key: ${err.error ?? `HTTP ${res.status}`}`);
    return;
  }

  output.success("API key created:");
  console.log(`  Name:    ${res.data.name}`);
  console.log(`  Scopes:  ${res.data.scopes.join(", ")}`);
  console.log(`  Expires: ${new Date(res.data.expiresAt).toLocaleDateString()}`);
  console.log();
  output.warn("Copy this token — it will not be shown again:");
  console.log(`  ${res.data.token}`);
}

export async function apiKeyRevokeCommand(id: string): Promise<void> {
  const res = await apiRequest("/api/api-keys/" + id, { method: "DELETE" });
  if (!res.ok) {
    const err = res.data as { error?: string };
    output.error(`Failed to revoke API key: ${err.error ?? `HTTP ${res.status}`}`);
    return;
  }

  output.success("API key revoked.");
}
