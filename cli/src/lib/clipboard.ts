/**
 * Clipboard utilities with auto-clear after 30 seconds.
 *
 * Uses clipboardy for cross-platform support.
 * Compares clipboard hash before clearing to avoid overwriting user's copy.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

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
  const timer = setTimeout(async () => {
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
  timer.unref();
  clearTimer = timer;
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
    // Best-effort synchronous clipboard clear — cannot await in exit handler.
    // Use platform-specific commands to actually clear the clipboard content.
    try {
      if (process.platform === "darwin") {
        execSync("pbcopy < /dev/null", { stdio: "ignore", timeout: 1000 });
      } else if (process.platform === "linux") {
        execSync("xclip -selection clipboard < /dev/null 2>/dev/null || xsel --clipboard --delete 2>/dev/null", { stdio: "ignore", timeout: 1000, shell: "/bin/sh" });
      }
    } catch {
      // Ignore — best effort only
    }
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
