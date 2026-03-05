/**
 * .passwd-sso-env.json loader.
 *
 * Schema:
 * {
 *   "server": "https://...",
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

export interface SecretMapping {
  entry: string;
  field: string;
}

export interface SecretsConfig {
  server: string;
  apiKey?: string;
  secrets: Record<string, SecretMapping>;
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

  if (!parsed.server || typeof parsed.server !== "string") {
    throw new Error("Config file must have a 'server' field.");
  }
  if (!parsed.secrets || typeof parsed.secrets !== "object") {
    throw new Error("Config file must have a 'secrets' field.");
  }

  return parsed;
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
