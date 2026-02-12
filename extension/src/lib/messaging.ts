import type { ExtensionMessage, ExtensionResponse } from "../types/messages";

/**
 * Send a typed message to the service worker and receive a typed response.
 */
export function sendMessage<T extends ExtensionMessage>(
  message: T,
): Promise<Extract<ExtensionResponse, { type: T["type"] }>> {
  return chrome.runtime.sendMessage(message);
}
