/**
 * Clipboard helper using the Chrome Offscreen API.
 *
 * Service workers have no DOM and cannot access the clipboard.
 * We create a minimal offscreen document that performs
 * document.execCommand("copy") on our behalf.
 */

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // Check the in-flight guard first to avoid a race where two callers both
  // see getContexts().length === 0 before either sets `creating`.
  if (creating) {
    await creating;
    return;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;

  creating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification: "Copy to clipboard",
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "clipboard-write",
    text,
  });
}
