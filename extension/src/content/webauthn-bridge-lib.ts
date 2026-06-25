// WebAuthn bridge logic — ISOLATED world.
// Receives postMessage from MAIN world interceptor, forwards to background,
// handles selection UI, and returns responses.
// Typed version for testing; entry point in webauthn-bridge.ts.

import { WEBAUTHN_BRIDGE_MSG, WEBAUTHN_BRIDGE_RESP, PASSKEY_BRIDGE_ACTION, EXT_MSG } from "../lib/constants";
import { MS_PER_SECOND } from "../lib/time";
import type { PasskeyMatchEntry } from "../types/messages";
import { showPasskeyDropdown, hidePasskeyDropdown } from "./ui/passkey-dropdown";
import { showPasskeySaveBanner } from "./ui/passkey-save-banner";

// User-presence gate: the terminal SIGN_ASSERTION / CREATE_CREDENTIAL actions
// must originate from a trusted in-bridge selection (a real dropdown click or
// save-banner press), NOT directly from a page postMessage. WebAuthn's
// user-presence guarantee is otherwise only enforced by convention in the
// MAIN-world interceptor, which page JS can bypass by posting the terminal
// action itself. We record a one-time authorization here on the trusted
// selection and require the terminal action to match it.
//
// Cross-origin theft is already blocked in the background (clientDataJSON.origin
// and the entry's rpId are bound to the sender tab URL). This gate closes the
// remaining same-origin gap: a page script (e.g. via stored XSS) skipping the
// dropdown to mint an assertion with no human gesture.
// Approvals are single-use AND short-lived. The TTL is a defense-in-depth
// backstop: in the normal flow the terminal action arrives immediately after
// the trusted selection, but if the MAIN-world interceptor goes silent after
// SELECT/CONFIRM_CREATE, an unconsumed approval must not linger indefinitely.
const APPROVAL_TTL_MS = 30 * MS_PER_SECOND;
interface SignApproval {
  entryId: string;
  expiresAt: number;
}
// Bind the create approval to the full identity shown in the save banner
// (rpId + userId + userName) so the credential actually created matches what
// the user consented to, not merely the same rpId.
interface CreateApproval {
  rpId: string;
  userId: string;
  userName: string;
  expiresAt: number;
}
let pendingSignApproval: SignApproval | null = null;
let pendingCreateApproval: CreateApproval | null = null;

function isContextValid(): boolean {
  try {
    return !!chrome.runtime && !!chrome.runtime.id;
  } catch {
    return false;
  }
}

function respond(requestId: string, response: unknown): void {
  window.postMessage(
    { type: WEBAUTHN_BRIDGE_RESP, requestId, response },
    window.location.origin,
  );
}

export function handleWebAuthnMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data || event.data.type !== WEBAUTHN_BRIDGE_MSG) return;
  if (!isContextValid()) return;

  const { requestId, action, payload } = event.data;
  if (!requestId || !action) return;

  switch (action) {
    case PASSKEY_BRIDGE_ACTION.GET_MATCHES:
      handleGetMatches(requestId, payload);
      break;
    case PASSKEY_BRIDGE_ACTION.SELECT:
      handleSelect(requestId, payload);
      break;
    case PASSKEY_BRIDGE_ACTION.SIGN_ASSERTION:
      handleSignAssertion(requestId, payload);
      break;
    case PASSKEY_BRIDGE_ACTION.CONFIRM_CREATE:
      handleConfirmCreate(requestId, payload);
      break;
    case PASSKEY_BRIDGE_ACTION.CREATE_CREDENTIAL:
      handleCreateCredential(requestId, payload);
      break;
  }
}

function handleGetMatches(requestId: string, payload: { rpId: string }): void {
  chrome.runtime.sendMessage(
    { type: EXT_MSG.PASSKEY_GET_MATCHES, rpId: payload.rpId },
    (response) => {
      if (chrome.runtime.lastError) { respond(requestId, null); return; }
      respond(requestId, response);
    },
  );
}

function handleSelect(
  requestId: string,
  payload: { entries: PasskeyMatchEntry[]; rpId: string },
): void {
  // A new selection round invalidates any prior unconsumed approval.
  pendingSignApproval = null;

  if (!payload.entries || payload.entries.length === 0) {
    respond(requestId, { action: "platform" });
    return;
  }

  showPasskeyDropdown({
    entries: payload.entries,
    rpId: payload.rpId,
    onSelect: (entry) => {
      hidePasskeyDropdown();
      // Authorize the subsequent SIGN_ASSERTION for exactly this entry.
      // The dropdown only invokes onSelect from a trusted (isTrusted) event.
      pendingSignApproval = { entryId: entry.id, expiresAt: Date.now() + APPROVAL_TTL_MS };
      respond(requestId, { action: "select", entry });
    },
    onPlatform: () => {
      hidePasskeyDropdown();
      respond(requestId, { action: "platform" });
    },
    onCancel: () => {
      hidePasskeyDropdown();
      respond(requestId, { action: "cancel" });
    },
  });
}

function handleSignAssertion(
  requestId: string,
  payload: { entryId: string; clientDataJSON: string; teamId?: string },
): void {
  // Fail closed unless a trusted selection authorized exactly this entry.
  // A page script that skips the dropdown and posts SIGN_ASSERTION directly
  // has no approval and is rejected here, before reaching the background.
  const approval = pendingSignApproval;
  pendingSignApproval = null; // single-use
  if (!approval || approval.entryId !== payload.entryId || approval.expiresAt < Date.now()) {
    respond(requestId, { ok: false, error: "USER_PRESENCE_REQUIRED" });
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: EXT_MSG.PASSKEY_SIGN_ASSERTION,
      entryId: payload.entryId,
      clientDataJSON: payload.clientDataJSON,
      teamId: payload.teamId,
    },
    (response) => {
      if (chrome.runtime.lastError) { respond(requestId, null); return; }
      respond(requestId, response);
    },
  );
}

function handleConfirmCreate(
  requestId: string,
  payload: { rpId: string; rpName: string; userName: string; userDisplayName: string; userId?: string },
): void {
  // A new create round invalidates any prior unconsumed approval.
  pendingCreateApproval = null;

  let resolved = false;
  const show = (existingEntries: PasskeyMatchEntry[]) => {
    if (resolved) return;
    resolved = true;
    showPasskeySaveBanner({
      rpName: payload.rpName,
      userName: payload.userName,
      existingEntries,
      onSave: (replaceEntryId?: string) => {
        // Authorize the subsequent CREATE_CREDENTIAL for this exact identity.
        // The save banner only invokes onSave from a trusted (isTrusted) press.
        pendingCreateApproval = {
          rpId: payload.rpId,
          userId: payload.userId ?? "",
          userName: payload.userName,
          expiresAt: Date.now() + APPROVAL_TTL_MS,
        };
        respond(requestId, { action: "save", replaceEntryId });
      },
      onDismiss: () => {
        respond(requestId, { action: "platform" });
      },
      onCancel: () => {
        respond(requestId, { action: "cancel" });
      },
    });
  };
  const fallthrough = () => {
    if (resolved) return;
    resolved = true;
    respond(requestId, { action: "platform" });
  };

  // Fallback: if SW callback never fires (MV3 SW sleep/terminate), fall through to platform
  const fallback = setTimeout(fallthrough, 2000);

  chrome.runtime.sendMessage(
    { type: EXT_MSG.PASSKEY_CHECK_DUPLICATE, rpId: payload.rpId, userName: payload.userName },
    (dupResponse) => {
      clearTimeout(fallback);
      if (chrome.runtime.lastError || dupResponse?.vaultLocked || dupResponse?.suppressed) {
        // All three cases fall through to the platform authenticator, but for different reasons:
        //   vaultLocked: vault is locked, cannot access stored passkeys
        //   suppressed:  on own app page, extension should not intercept WebAuthn
        //   lastError:   service worker error, cannot communicate with background
        fallthrough();
        return;
      }
      show(dupResponse?.entries ?? []);
    },
  );
}

function handleCreateCredential(
  requestId: string,
  payload: {
    rpId: string;
    rpName: string;
    userId: string;
    userName: string;
    userDisplayName: string;
    excludeCredentialIds: string[];
    clientDataJSON: string;
    replaceEntryId?: string;
  },
): void {
  // Fail closed unless a trusted save-banner press authorized this rpId.
  const approval = pendingCreateApproval;
  pendingCreateApproval = null; // single-use
  if (
    !approval ||
    approval.rpId !== payload.rpId ||
    approval.userId !== payload.userId ||
    approval.userName !== payload.userName ||
    approval.expiresAt < Date.now()
  ) {
    respond(requestId, { ok: false, error: "USER_PRESENCE_REQUIRED" });
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: EXT_MSG.PASSKEY_CREATE_CREDENTIAL,
      rpId: payload.rpId,
      rpName: payload.rpName,
      userId: payload.userId,
      userName: payload.userName,
      userDisplayName: payload.userDisplayName,
      excludeCredentialIds: payload.excludeCredentialIds,
      clientDataJSON: payload.clientDataJSON,
      replaceEntryId: payload.replaceEntryId,
    },
    (response) => {
      if (chrome.runtime.lastError) { respond(requestId, null); return; }
      respond(requestId, response);
    },
  );
}
