// Answering HTTP Basic/Digest challenges with a bound LOGIN entry (issue #905).
//
// Control class: a fail-closed verification gate plus an explicit user decision
// per challenge. Every challenge is answered {} (Chrome's own dialog) unless
// every rule in decideChallenge holds, and the credential leaves only after the
// user clicked Send in the confirmation window. Nothing here ever answers with
// the request-blocking field of BlockingResponse: that would take away the
// user's own manual login (a static test over this file enforces it).
//
// Adjudication authority: Chrome's `details` (url, challenger, type, frameType,
// documentLifecycle), chrome.permissions.contains, and the user's click. The
// stored binding is untrusted (storage.local is writable from content scripts).
//
// Answering never registers vault activity: a challenge must not keep the vault
// unlocked.

import {
  HTTP_AUTH_API_PERMISSIONS,
  HTTP_AUTH_PENDING_INTENT_KEY,
  getBinding,
  isBinding,
  isPendingIntent,
  normalizeOrigin,
  originPattern,
  releasePermissions,
  setBinding,
} from "../lib/http-auth-bindings";
import { EXT_ENTRY_TYPE } from "../lib/constants";
import { MS_PER_SECOND } from "../lib/time";
import type { HttpAuthDecision } from "../types/messages";
import { savedUrlOrigins } from "./entry-origins";
import { handlePromptRequestError, type PromptRequest } from "./http-auth-prompt";
import { classifyError, warnBackground } from "./log";

/** The fields of chrome.webRequest.OnAuthRequiredDetails the rules read. */
export type AuthChallenge = {
  requestId: string;
  url: string;
  tabId: number;
  type: string;
  frameType?: string;
  documentLifecycle?: string;
  initiator?: string;
  isProxy: boolean;
  scheme: string;
  challenger: { host: string; port: number };
};

export type AuthCredentials = { username: string; password: string };
/** {} lets Chrome show its own dialog. */
export type AuthAnswer = { authCredentials?: AuthCredentials };

/** The decrypted entry as background/index.ts fetchAndDecryptEntry returns it. */
export type EntryAccess =
  | {
      ok: true;
      blob: { url?: unknown; customFields?: unknown; username?: unknown; password?: unknown };
      overview: { username?: unknown };
      entryType: string;
    }
  | { ok: false; error: string };

export type EntryOverview = { title: string; username: string; entryType: string };

export type HttpAuthDeps = {
  isVaultUnlocked: () => boolean;
  /** The unlocked vault's account, or null while locked. */
  currentUserId: () => string | null;
  awaitHydrationBounded: () => Promise<void>;
  currentVaultEpoch: () => number;
  isVaultEpochCurrent: (epoch: number) => boolean;
  fetchAndDecryptEntry: (entryId: string, teamId: string | undefined, epoch: number) => Promise<EntryAccess>;
  /** The cached overview (title, username) the prompt shows: never a full decrypt. */
  getEntryOverview: (entryId: string, teamId: string | undefined) => Promise<EntryOverview | null>;
  openPrompt: (req: PromptRequest) => Promise<HttpAuthDecision>;
};

export const ANSWERED_REQUEST_LIMIT = 256;
/** Bound on each network-backed step of an answer (the overview read, and the full decrypt after Send). */
export const DECRYPT_DEADLINE_MS = 10 * MS_PER_SECOND;

let deps: HttpAuthDeps | null = null;
// Request ids seen, oldest first (Map keeps insertion order). A re-raised
// challenge for the same request (wrong credentials, or Chrome's retry after
// {}) falls to Chrome's dialog. A SW restart forgets them, which is accepted.
const seenRequests = new Map<string, true>();

/** Wire the dependencies and reset per-SW state. */
export function initHttpAuth(next: HttpAuthDeps): void {
  deps = next;
  seenRequests.clear();
}

/** Record `requestId`; false when it was already seen. */
function firstReceipt(requestId: string): boolean {
  if (seenRequests.has(requestId)) return false;
  seenRequests.set(requestId, true);
  while (seenRequests.size > ANSWERED_REQUEST_LIMIT) {
    const oldest = seenRequests.keys().next().value;
    if (oldest === undefined) break;
    seenRequests.delete(oldest);
  }
  return true;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The credential `access` may release for `origin`, or null: a LOGIN with a
 * non-empty username and password and a saved URL (the url or a url-type
 * custom field) whose normalized origin is exactly `origin`. Shared by
 * registration and by every answer, so an http origin is answered only for an
 * entry saved with that http URL.
 */
export function credentialsForOrigin(access: EntryAccess, origin: string): AuthCredentials | null {
  if (!access.ok || access.entryType !== EXT_ENTRY_TYPE.LOGIN) return null;
  const username = nonEmpty(access.overview.username) ?? nonEmpty(access.blob.username);
  const password = nonEmpty(access.blob.password);
  if (!username || !password) return null;
  if (!savedUrlOrigins(access.blob).includes(origin)) return null;
  return { username, password };
}

/** The challenger as an origin on the request URL's scheme. */
function challengerOrigin(details: AuthChallenge, protocol: string): string | null {
  const { host, port } = details.challenger ?? {};
  if (typeof host !== "string" || host === "" || !Number.isInteger(port)) return null;
  // An IPv6 literal may arrive without brackets.
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return normalizeOrigin(`${protocol}//${bracketed}:${port}`);
}

async function hasOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

async function isIncognitoTab(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId);
  return tab.incognito !== false;
}

const TIMED_OUT = Symbol("timed-out");

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The credential for this challenge, or null for {}. Rules numbered as in the plan (C4). */
async function decideChallenge(details: AuthChallenge): Promise<AuthCredentials | null> {
  const d = deps;
  if (!d) return null;
  // 5. Recorded at first receipt, so every terminal outcome ends the request.
  if (!firstReceipt(details.requestId)) return null;
  // 1. Origin servers only, never a proxy.
  if (details.isProxy !== false) return null;
  // 2. Basic or Digest only (never NTLM/Negotiate).
  const scheme = typeof details.scheme === "string" ? details.scheme.toLowerCase() : "";
  if (scheme !== "basic" && scheme !== "digest") return null;
  // 3. A top-level navigation in an active document of a normal tab.
  if (!(details.tabId >= 0)) return null;
  if (details.type !== "main_frame" || details.frameType !== "outermost_frame") return null;
  if (details.documentLifecycle !== undefined && details.documentLifecycle !== "active") return null;
  // 4. A binding for exactly the challenged origin, named by the challenger too,
  //    and the origin's host permission.
  const origin = normalizeOrigin(details.url);
  if (!origin) return null;
  if (challengerOrigin(details, new URL(origin).protocol) !== origin) return null;
  if (await isIncognitoTab(details.tabId)) return null;
  const binding = await getBinding(origin);
  if (!binding) return null;
  if (!(await hasOriginPermission(origin))) return null;
  // 6. A challenge can wake the SW mid-hydration.
  await d.awaitHydrationBounded();
  if (!d.isVaultUnlocked()) return null;
  // Bindings survive a disconnect or an account switch: answer only for the
  // account that registered this one (a binding without an account never).
  if (binding.userId === undefined || binding.userId !== d.currentUserId()) return null;
  // 8 starts here: the vault state this answer belongs to.
  const epoch = d.currentVaultEpoch();
  // The cache read can fetch and decrypt overviews: bounded like the decrypt.
  const overview = await withDeadline(d.getEntryOverview(binding.entryId, binding.teamId), DECRYPT_DEADLINE_MS);
  if (overview === TIMED_OUT || !overview || overview.entryType !== EXT_ENTRY_TYPE.LOGIN) return null;
  if (!d.isVaultEpochCurrent(epoch)) return null;
  // 7. The user's decision. Only the overview has been read so far.
  const decision = await d.openPrompt({
    requestId: details.requestId,
    tabId: details.tabId,
    url: details.url,
    origin,
    initiator: typeof details.initiator === "string" ? details.initiator : null,
    scheme,
    entryTitle: overview.title,
    entryUsername: overview.username,
    insecure: origin.startsWith("http:"),
  });
  if (decision !== "send") return null;
  // 4 again: the binding may have been removed or replaced while the window
  // was open, or the permission revoked.
  const current = await getBinding(origin);
  if (
    !current ||
    current.entryId !== binding.entryId ||
    current.teamId !== binding.teamId ||
    current.userId !== binding.userId
  ) {
    return null;
  }
  if (!(await hasOriginPermission(origin))) return null;
  if (!d.isVaultEpochCurrent(epoch)) return null;
  // The full decrypt happens only now, bounded.
  const access = await withDeadline(
    d.fetchAndDecryptEntry(binding.entryId, binding.teamId, epoch),
    DECRYPT_DEADLINE_MS,
  );
  if (access === TIMED_OUT) return null;
  // 8. Unchanged from the challenge through the decrypt.
  if (!d.isVaultEpochCurrent(epoch)) return null;
  // 9. The entry still qualifies for this exact origin.
  return credentialsForOrigin(access, origin);
}

/**
 * The asyncBlocking onAuthRequired handler. Calls `callback` exactly once, and
 * returns its own work so a test can await it (Chrome ignores the return).
 * Any error answers {}.
 */
export async function handleAuthRequired(
  details: AuthChallenge,
  callback: (answer: AuthAnswer) => void,
): Promise<void> {
  let answered = false;
  const answer = (response: AuthAnswer): void => {
    if (answered) return;
    answered = true;
    try {
      callback(response);
    } catch (err) {
      warnBackground("http-auth-answer-failed", classifyError(err));
    }
  };
  try {
    const credentials = await decideChallenge(details);
    answer(credentials ? { authCredentials: credentials } : {});
  } catch (err) {
    warnBackground("http-auth-answer-failed", classifyError(err));
    answer({});
  }
}

// ── Registration (C3) ───────────────────────────────────────────

export type RegistrationRequest = { origin: unknown; entryId: unknown; teamId?: unknown };
export type RegistrationResult = { ok: true } | { ok: false; error: string };

async function checkRegistration(
  d: HttpAuthDeps,
  origin: string,
  entryId: string,
  teamId: string | undefined,
): Promise<RegistrationResult> {
  if (!d.isVaultUnlocked()) return { ok: false, error: "VAULT_LOCKED" };
  const granted = await chrome.permissions.contains({
    origins: [originPattern(origin)],
    permissions: [...HTTP_AUTH_API_PERMISSIONS],
  });
  if (!granted) return { ok: false, error: "HTTP_AUTH_PERMISSION_DENIED" };
  const epoch = d.currentVaultEpoch();
  const access = await d.fetchAndDecryptEntry(entryId, teamId, epoch);
  if (!access.ok) return { ok: false, error: access.error };
  if (!d.isVaultEpochCurrent(epoch)) return { ok: false, error: "VAULT_LOCKED" };
  if (!credentialsForOrigin(access, origin)) return { ok: false, error: "HTTP_AUTH_ENTRY_MISMATCH" };
  return { ok: true };
}

/**
 * Bind `entryId` to `origin` after the user granted the permissions. Any
 * failure gives back what was granted (releasePermissions keeps what another
 * binding or the server needs), so no permission is left without a binding.
 * Idempotent: re-registering the same binding is a no-op that keeps it.
 */
export async function registerHttpAuthBinding(req: RegistrationRequest): Promise<RegistrationResult> {
  const d = deps;
  if (!d) return { ok: false, error: "INTERNAL_ERROR" };
  const origin = typeof req.origin === "string" ? normalizeOrigin(req.origin) : null;
  const rollback = async (result: RegistrationResult): Promise<RegistrationResult> => {
    if (origin) {
      try {
        await releasePermissions(origin);
      } catch (err) {
        warnBackground("http-auth-permission-remove-failed", classifyError(err));
      }
    }
    return result;
  };
  if (!origin || origin !== req.origin) return rollback({ ok: false, error: "INVALID_URL" });
  const candidate = {
    origin,
    entryId: req.entryId,
    ...(req.teamId !== undefined && req.teamId !== null ? { teamId: req.teamId } : {}),
  };
  if (!isBinding(candidate)) return rollback({ ok: false, error: "HTTP_AUTH_ENTRY_MISMATCH" });
  const { entryId, teamId } = candidate;

  const userId = d.currentUserId();
  const existing = await getBinding(origin);
  if (
    userId !== null &&
    existing?.entryId === entryId &&
    existing.teamId === teamId &&
    existing.userId === userId
  ) {
    return { ok: true };
  }

  const checked = await checkRegistration(d, origin, entryId, teamId);
  if (!checked.ok) return rollback(checked);
  // The account the entry was decrypted for: a challenge is answered only
  // while that account's vault is unlocked.
  if (userId === null || d.currentUserId() !== userId) return rollback({ ok: false, error: "VAULT_LOCKED" });
  await setBinding({ origin, entryId, ...(teamId !== undefined ? { teamId } : {}), userId });
  registerHttpAuthListeners();
  return { ok: true };
}

async function readPendingIntent() {
  const stored = (await chrome.storage.session.get(HTTP_AUTH_PENDING_INTENT_KEY))?.[
    HTTP_AUTH_PENDING_INTENT_KEY
  ];
  return isPendingIntent(stored) ? stored : null;
}

/** Clear the pending intent the popup wrote, when it is the one `nonce` names. */
export async function clearPendingIntent(nonce: unknown): Promise<void> {
  if (typeof nonce !== "string") return;
  const intent = await readPendingIntent();
  if (intent?.nonce === nonce) await chrome.storage.session.remove(HTTP_AUTH_PENDING_INTENT_KEY);
}

/**
 * Complete the popup's pending registration when its grant arrives without the
 * popup (it closed on the permission prompt). Only a fresh intent whose origin
 * pattern is in `addedOrigins` (or, at SW start, already granted) and only
 * while the API permissions are present. Completion clears the slot.
 */
export async function completePendingIntent(addedOrigins: readonly string[] | null): Promise<void> {
  const d = deps;
  if (!d) return;
  const intent = await readPendingIntent();
  if (!intent) return;
  if (intent.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(HTTP_AUTH_PENDING_INTENT_KEY);
    return;
  }
  const pattern = originPattern(intent.origin);
  const originGranted =
    addedOrigins === null
      ? await chrome.permissions.contains({ origins: [pattern] })
      : addedOrigins.includes(pattern);
  if (!originGranted) return;
  if (!(await chrome.permissions.contains({ permissions: [...HTTP_AUTH_API_PERMISSIONS] }))) return;
  await chrome.storage.session.remove(HTTP_AUTH_PENDING_INTENT_KEY);
  await d.awaitHydrationBounded();
  await registerHttpAuthBinding(intent);
}

// ── Listener lifecycle (C6) ─────────────────────────────────────

const REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"],
  types: ["main_frame"],
};

function onAuthRequired(
  details: chrome.webRequest.OnAuthRequiredDetails,
  asyncCallback?: (response: chrome.webRequest.BlockingResponse) => void,
): undefined {
  void handleAuthRequired(details, (answer) => asyncCallback?.(answer));
  return undefined;
}

function onErrorOccurred(details: chrome.webRequest.OnErrorOccurredDetails): void {
  handlePromptRequestError(details.requestId);
}

function isApiPermissionChange(change: chrome.permissions.Permissions): boolean {
  return (change.permissions ?? []).some((p) =>
    (HTTP_AUTH_API_PERMISSIONS as readonly string[]).includes(p),
  );
}

/**
 * Register the challenge listener when the API exists (after the optional
 * grant). Idempotent, and a throw is logged, never propagated: SW start must
 * go on without it.
 */
export function registerHttpAuthListeners(): void {
  try {
    const webRequest = chrome.webRequest;
    const auth = webRequest?.onAuthRequired;
    if (!auth) return;
    if (!auth.hasListener(onAuthRequired)) {
      auth.addListener(onAuthRequired, REQUEST_FILTER, ["asyncBlocking"]);
    }
    const errors = webRequest.onErrorOccurred;
    if (errors && !errors.hasListener(onErrorOccurred)) {
      errors.addListener(onErrorOccurred, REQUEST_FILTER);
    }
  } catch (err) {
    warnBackground("http-auth-listener-register-failed", classifyError(err));
  }
}

export function unregisterHttpAuthListeners(): void {
  try {
    // The namespace is gone once its permission is removed.
    const webRequest = chrome.webRequest;
    webRequest?.onAuthRequired?.removeListener(onAuthRequired);
    webRequest?.onErrorOccurred?.removeListener(onErrorOccurred);
  } catch (err) {
    warnBackground("http-auth-listener-unregister-failed", classifyError(err));
  }
}

async function onPermissionsAdded(added: chrome.permissions.Permissions): Promise<void> {
  if (isApiPermissionChange(added)) registerHttpAuthListeners();
  try {
    await completePendingIntent(added.origins ?? []);
  } catch (err) {
    warnBackground("http-auth-listener-register-failed", classifyError(err));
  }
}

function onPermissionsRemoved(removed: chrome.permissions.Permissions): void {
  if (isApiPermissionChange(removed)) unregisterHttpAuthListeners();
}

const permissionsAddedListener = (added: chrome.permissions.Permissions): void => {
  void onPermissionsAdded(added);
};

/**
 * Called once, synchronously, at the top level of the service worker: the
 * challenge listener (when already granted), the grant/revoke events, and a
 * pending registration whose grant restarted the SW before onAdded reached it.
 * Nothing here throws.
 */
export function installHttpAuthLifecycle(): void {
  registerHttpAuthListeners();
  for (const [event, listener] of [
    [chrome.permissions?.onAdded, permissionsAddedListener],
    [chrome.permissions?.onRemoved, onPermissionsRemoved],
  ] as const) {
    try {
      if (!event || event.hasListener(listener)) continue;
      event.addListener(listener);
    } catch (err) {
      warnBackground("http-auth-listener-register-failed", classifyError(err));
    }
  }
  completePendingIntent(null).catch((err: unknown) => {
    warnBackground("http-auth-listener-register-failed", classifyError(err));
  });
}
