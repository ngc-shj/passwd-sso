import type { ExtensionMessage, ExtensionResponse } from "../types/messages";

// ── In-memory token storage (never persisted to disk) ────────

let currentToken: string | null = null;
let tokenExpiresAt: number | null = null;

const ALARM_NAME = "extension-token-ttl";

/** Securely clear token from memory */
function zeroize(): void {
  currentToken = null;
  tokenExpiresAt = null;
}

// ── Alarm: auto-clear on expiry ──────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    zeroize();
  }
});

// ── Message handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {
    switch (message.type) {
      case "SET_TOKEN": {
        currentToken = message.token;
        tokenExpiresAt = message.expiresAt;

        // Set alarm for TTL expiry
        const delayMs = message.expiresAt - Date.now();
        if (delayMs > 0) {
          chrome.alarms.create(ALARM_NAME, {
            when: message.expiresAt,
          });
        } else {
          // Already expired
          zeroize();
        }

        sendResponse({ type: "SET_TOKEN", ok: true });
        break;
      }

      case "GET_TOKEN": {
        // Check if expired
        if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
          zeroize();
        }
        sendResponse({ type: "GET_TOKEN", token: currentToken });
        break;
      }

      case "CLEAR_TOKEN": {
        zeroize();
        chrome.alarms.clear(ALARM_NAME);
        sendResponse({ type: "CLEAR_TOKEN", ok: true });
        break;
      }

      case "GET_STATUS": {
        // Check if expired
        if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
          zeroize();
        }
        sendResponse({
          type: "GET_STATUS",
          hasToken: currentToken !== null,
          expiresAt: tokenExpiresAt,
        });
        break;
      }

      default:
        // Unknown message — do not hold the channel open
        return false;
    }

    // Return true to indicate async sendResponse
    return true;
  },
);
