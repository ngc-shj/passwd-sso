// WebAuthn bridge logic — ISOLATED world.
// Receives postMessage from MAIN world interceptor, forwards to background,
// handles selection UI, and returns responses.
// Typed version for testing; entry point in webauthn-bridge.ts.

import { WEBAUTHN_BRIDGE_MSG, WEBAUTHN_BRIDGE_RESP } from "../lib/constants";
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
    case "PASSKEY_GET_MATCHES":
      handleGetMatches(requestId, payload);
      break;
    case "PASSKEY_SELECT":
      handleSelect(requestId, payload);
      break;
    case "PASSKEY_SIGN_ASSERTION":
      handleSignAssertion(requestId, payload);
      break;
    case "PASSKEY_CONFIRM_CREATE":
      handleConfirmCreate(requestId, payload);
      break;
    case "PASSKEY_CREATE_CREDENTIAL":
      handleCreateCredential(requestId, payload);
      break;
  }
}

function handleGetMatches(requestId: string, payload: { rpId: string }): void {
  chrome.runtime.sendMessage(
    { type: "PASSKEY_GET_MATCHES", rpId: payload.rpId },
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
      type: "PASSKEY_SIGN_ASSERTION",
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
  payload: { rpId: string; rpName: string; userName: string; userDisplayName: string },
): void {
  showPasskeySaveBanner({
    rpName: payload.rpName,
    userName: payload.userName,
    onSave: () => {
      respond(requestId, { action: "save" });
    },
    onDismiss: () => {
      respond(requestId, { action: "platform" });
    },
  });
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
  },
): void {
  chrome.runtime.sendMessage(
    {
      type: "PASSKEY_CREATE_CREDENTIAL",
      rpId: payload.rpId,
      rpName: payload.rpName,
      userId: payload.userId,
      userName: payload.userName,
      userDisplayName: payload.userDisplayName,
      excludeCredentialIds: payload.excludeCredentialIds,
      clientDataJSON: payload.clientDataJSON,
    },
    (response) => {
      if (chrome.runtime.lastError) { respond(requestId, null); return; }
      respond(requestId, response);
    },
  );
}
