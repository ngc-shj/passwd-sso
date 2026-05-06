/**
 * .passwd-sso-env.json loader.
 *
 * Schema:
 * {
 *   "apiKey?": "api_...",         // optional — uses /api/v1/ path
 *   "secrets": {
 *     "ENV_VAR_NAME": { "entry": "<entryId>", "field": "password" }
 *   }
 * }
 *
 * Auth flow:
 *   apiKey present → /api/v1/passwords (Bearer api_key)
 *   apiKey absent  → /api/passwords   (Bearer extension token via login)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { validateServerUrl } from "./oauth.js";

export interface SecretMapping {
  entry: string;
  field: string;
}

export interface SecretsConfig {
  apiKey?: string;
  secrets: Record<string, SecretMapping>;
}

function isPlaceholderEntryId(entryId: string): boolean {
  const trimmed = entryId.trim();
  return trimmed === "dummy-entry-id" || /^<[^>]+>$/.test(trimmed);
}

export function loadSecretsConfig(configPath?: string): SecretsConfig {
  const filePath = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), ".passwd-sso-env.json");

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as SecretsConfig;

  if (!parsed.secrets || typeof parsed.secrets !== "object") {
    throw new Error("Config file must have a 'secrets' field.");
  }

  for (const [envName, mapping] of Object.entries(parsed.secrets)) {
    if (!mapping || typeof mapping !== "object") {
      throw new Error(`Secret mapping for '${envName}' must be an object.`);
    }

    const raw = mapping as Partial<SecretMapping>;
    if (typeof raw.entry !== "string" || raw.entry.trim().length === 0) {
      throw new Error(`Secret mapping for '${envName}' must have a non-empty 'entry' string.`);
    }
    if (typeof raw.field !== "string" || raw.field.trim().length === 0) {
      throw new Error(`Secret mapping for '${envName}' must have a non-empty 'field' string.`);
    }
    const entry = raw.entry.trim();
    const field = raw.field.trim();
    if (isPlaceholderEntryId(entry)) {
      throw new Error(
        `Secret mapping for '${envName}' uses placeholder entry ID "${entry}". Replace it with a real vault entry ID.`,
      );
    }
    parsed.secrets[envName] = { entry, field };
  }

  return parsed;
}

export function getSecretsServerUrl(): string {
  const { serverUrl } = loadConfig();
  if (!serverUrl) {
    throw new Error(
      "Server URL not configured. Run `passwd-sso login -s <server-url>` once to configure it.",
    );
  }
  // Defense-in-depth: re-validate the persisted URL before issuing a fetch
  // with a Bearer token. Login validates at write time, but a hand-edited
  // config file would otherwise reach fetch() unchecked.
  validateServerUrl(serverUrl);
  return serverUrl.replace(/\/$/, "");
}

/**
 * Returns the API path for fetching a single password entry.
 * If apiKey is configured, use the public /api/v1/ path.
 */
export function getPasswordPath(entryId: string, useV1: boolean): string {
  if (/[\/\\]/.test(entryId)) {
    throw new Error(`Invalid entry ID: "${entryId}"`);
  }
  return useV1
    ? `/api/v1/passwords/${encodeURIComponent(entryId)}`
    : `/api/passwords/${encodeURIComponent(entryId)}`;
}
