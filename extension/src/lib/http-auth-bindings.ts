// HTTP authentication bindings (issue #905): which LOGIN entry answers a
// Basic/Digest challenge from which origin. Imported by the service worker and
// the options page. Holds no secret: an origin and an entry id.
//
// chrome.storage.local is writable from content scripts, so a binding read here
// is untrusted input. A forged one still needs the origin's host permission, a
// click in the confirmation window and an entry whose saved URL has that exact
// origin (background/http-auth.ts) before anything is released.

import { getSettings } from "./storage";
import { MS_PER_MINUTE } from "./time";
import { classifyError, warnBackground } from "../background/log";

export type HttpAuthBinding = { origin: string; entryId: string; teamId?: string };

export const HTTP_AUTH_BINDINGS_KEY = "httpAuthBindings";

/**
 * The registration the popup is asking permissions for, written to
 * chrome.storage.session right before chrome.permissions.request. The popup
 * may close while the permission prompt is up; the service worker then
 * completes the registration from this slot when the grant arrives.
 */
export type HttpAuthPendingIntent = {
  nonce: string;
  origin: string;
  entryId: string;
  teamId?: string;
  expiresAt: number;
};

export const HTTP_AUTH_PENDING_INTENT_KEY = "httpAuthPendingIntent";
export const HTTP_AUTH_INTENT_TTL_MS = 2 * MS_PER_MINUTE;

/** The optional API permissions an answer needs, granted with the first binding. */
export const HTTP_AUTH_API_PERMISSIONS = ["webRequest", "webRequestAuthProvider"] as const;

// Same bound as the background's content-supplied ids: entry ids are mixed
// CUID v1 and UUIDv4, so this is a charset/length bound, not a format check.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The origin an http(s) URL belongs to, as `URL.origin` serializes it: scheme,
 * lowercased host (IDN in punycode, IPv6 in brackets) and the port only when it
 * is not the scheme's default. Credentials, path, query and fragment are
 * dropped. Null for anything that is not an http(s) URL with a host.
 */
export function normalizeOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.origin;
}

/** The host-permission match pattern for a normalized origin. */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

/**
 * Whether the pattern granted for `patternOrigin` also covers `origin`. A
 * pattern without a port matches every port of its host
 * (`http://localhost/*` covers `http://localhost:3001`); one with a port
 * matches only that port. Scheme and host must be equal.
 */
export function patternCovers(patternOrigin: string, origin: string): boolean {
  let pattern: URL;
  let target: URL;
  try {
    pattern = new URL(patternOrigin);
    target = new URL(origin);
  } catch {
    return false;
  }
  if (pattern.protocol !== target.protocol || pattern.hostname !== target.hostname) return false;
  return pattern.port === "" || pattern.port === target.port;
}

function isBinding(value: unknown): value is HttpAuthBinding {
  if (typeof value !== "object" || value === null) return false;
  const { origin, entryId, teamId } = value as Record<string, unknown>;
  if (typeof origin !== "string" || normalizeOrigin(origin) !== origin) return false;
  if (typeof entryId !== "string" || !ID_RE.test(entryId)) return false;
  return teamId === undefined || (typeof teamId === "string" && ID_RE.test(teamId));
}

export function isPendingIntent(value: unknown): value is HttpAuthPendingIntent {
  if (typeof value !== "object" || value === null) return false;
  const { nonce, expiresAt } = value as Record<string, unknown>;
  return (
    typeof nonce === "string" &&
    nonce.length > 0 &&
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    isBinding(value)
  );
}

/** Every valid stored binding, one per origin. A malformed record is dropped. */
export async function listBindings(): Promise<HttpAuthBinding[]> {
  const stored = (await chrome.storage.local.get(HTTP_AUTH_BINDINGS_KEY))?.[HTTP_AUTH_BINDINGS_KEY];
  if (!Array.isArray(stored)) return [];
  const byOrigin = new Map<string, HttpAuthBinding>();
  for (const record of stored) {
    if (!isBinding(record) || byOrigin.has(record.origin)) continue;
    byOrigin.set(record.origin, {
      origin: record.origin,
      entryId: record.entryId,
      ...(record.teamId !== undefined ? { teamId: record.teamId } : {}),
    });
  }
  return [...byOrigin.values()];
}

export async function getBinding(origin: string): Promise<HttpAuthBinding | null> {
  return (await listBindings()).find((b) => b.origin === origin) ?? null;
}

/** Store `binding`, replacing any binding for the same origin. */
export async function setBinding(binding: HttpAuthBinding): Promise<void> {
  if (!isBinding(binding)) throw new Error("INVALID_BINDING");
  const others = (await listBindings()).filter((b) => b.origin !== binding.origin);
  await chrome.storage.local.set({ [HTTP_AUTH_BINDINGS_KEY]: [...others, binding] });
}

export async function removeBinding(origin: string): Promise<void> {
  const remaining = (await listBindings()).filter((b) => b.origin !== origin);
  await chrome.storage.local.set({ [HTTP_AUTH_BINDINGS_KEY]: remaining });
}

/**
 * Give back what was granted for `origin` once nothing needs it. Its host
 * pattern stays while a stored binding or the configured server origin is
 * covered by it; the API permissions stay while any binding remains. Call after
 * removeBinding, or after a registration that stored nothing. A failed remove
 * (a required or already-removed permission) is logged and skipped.
 */
export async function releasePermissions(origin: string): Promise<void> {
  const bindings = await listBindings();
  const serverOrigin = normalizeOrigin((await getSettings()).serverUrl);
  const needed =
    bindings.some((b) => patternCovers(origin, b.origin)) ||
    (serverOrigin !== null && patternCovers(origin, serverOrigin));
  if (!needed) {
    try {
      await chrome.permissions.remove({ origins: [originPattern(origin)] });
    } catch (err) {
      warnBackground("http-auth-permission-remove-failed", classifyError(err));
    }
  }
  if (bindings.length === 0) {
    try {
      await chrome.permissions.remove({ permissions: [...HTTP_AUTH_API_PERMISSIONS] });
    } catch (err) {
      warnBackground("http-auth-permission-remove-failed", classifyError(err));
    }
  }
}
