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

export async function apiKeyListCommand(options: { json?: boolean } = {}): Promise<void> {
  const res = await apiRequest<ApiKeyEntry[]>("/api/api-keys");
  if (!res.ok) {
    output.error(`Failed to list API keys: HTTP ${res.status}`);
    return;
  }

  const keys = res.data;
  if (keys.length === 0) {
    if (options.json) {
      output.json([]);
    } else {
      output.info("No API keys found.");
    }
    return;
  }

  if (options.json) {
    output.json(keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes,
      status: key.revokedAt
        ? "revoked"
        : new Date(key.expiresAt) < new Date()
          ? "expired"
          : "active",
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt,
      lastUsedAt: key.lastUsedAt,
    })));
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
      key.id,
      key.name,
      key.prefix + "...",
      key.scopes.join(", "),
      status,
      new Date(key.expiresAt).toLocaleDateString(),
      key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "never",
    ]);
  }
  output.table(["ID", "Name", "Prefix", "Scopes", "Status", "Expires", "Last Used"], rows);
}

interface CreateOptions {
  name: string;
  scopes: string[];
  days: number;
  json?: boolean;
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

  if (opts.json) {
    output.json({
      id: res.data.id,
      token: res.data.token,
      name: res.data.name,
      prefix: res.data.prefix,
      scopes: res.data.scopes,
      expiresAt: res.data.expiresAt,
    });
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

export async function apiKeyRevokeCommand(id: string, options: { json?: boolean } = {}): Promise<void> {
  const res = await apiRequest(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const err = res.data as { error?: string };
    if (options.json) {
      output.json({ success: false, error: err.error ?? `HTTP ${res.status}` });
    } else {
      output.error(`Failed to revoke API key: ${err.error ?? `HTTP ${res.status}`}`);
    }
    return;
  }

  if (options.json) {
    output.json({ success: true, id });
  } else {
    output.success("API key revoked.");
  }
}
