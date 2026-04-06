// WebAuthn bridge logic — ISOLATED world.
// Receives postMessage from MAIN world interceptor, forwards to background,
// handles selection UI, and returns responses.
// Typed version for testing; entry point in webauthn-bridge.ts.

import { WEBAUTHN_BRIDGE_MSG, WEBAUTHN_BRIDGE_RESP, PASSKEY_BRIDGE_ACTION, EXT_MSG } from "../lib/constants";
import type { PasskeyMatchEntry } from "../types/messages";
import { showPasskeyDropdown, hidePasskeyDropdown } from "./ui/passkey-dropdown";
import { showPasskeySaveBanner } from "./ui/passkey-save-banner";

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
  if (!payload.entries || payload.entries.length === 0) {
    respond(requestId, { action: "platform" });
    return;
  }

  showPasskeyDropdown({
    entries: payload.entries,
    rpId: payload.rpId,
    onSelect: (entry) => {
      hidePasskeyDropdown();
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
  let resolved = false;
  const show = (existingEntries: PasskeyMatchEntry[]) => {
    if (resolved) return;
    resolved = true;
    showPasskeySaveBanner({
      rpName: payload.rpName,
      userName: payload.userName,
      existingEntries,
      onSave: (replaceEntryId?: string) => {
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
        // Vault locked, own app suppression, or SW error — fall through to platform authenticator
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
