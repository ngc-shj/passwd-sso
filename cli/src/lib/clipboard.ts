/**
 * Clipboard utilities with auto-clear after 30 seconds.
 *
 * Uses clipboardy for cross-platform support.
 * Compares clipboard hash before clearing to avoid overwriting user's copy.
 */

import { createHash } from "node:crypto";

const CLEAR_TIMEOUT_MS = 30_000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let copiedHash: string | null = null;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function getClipboardy() {
  return import("clipboardy");
}

export async function copyToClipboard(content: string): Promise<void> {
  const { default: clipboardy } = await getClipboardy();
  await clipboardy.write(content);
  copiedHash = hashContent(content);

  // Cancel previous timer
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  // Schedule auto-clear
  clearTimer = setTimeout(async () => {
    try {
      const current = await clipboardy.read();
      if (copiedHash && hashContent(current) === copiedHash) {
        await clipboardy.write("");
      }
    } catch {
      // ignore clipboard read errors
    }
    copiedHash = null;
    clearTimer = null;
  }, CLEAR_TIMEOUT_MS);
}

export function clearPendingClipboard(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  copiedHash = null;
}

// Signal handlers to clear clipboard on exit
function onExit(): void {
  if (copiedHash) {
    // Best-effort synchronous clear — cannot await in exit handler
    clearPendingClipboard();
  }
}

process.on("SIGINT", () => {
  onExit();
  process.exit(130);
});
process.on("SIGTERM", () => {
  onExit();
  process.exit(143);
});
process.on("exit", onExit);
