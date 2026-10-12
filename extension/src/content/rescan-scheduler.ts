// Leaf module: imports nothing from content/. Coalesces attribute-only
// mutation bursts into at most one trailing rescan per window, and lets
// a focus on a non-member decide whether a pending or just-finished burst is
// worth flushing before the dropdown's own visual-safety gates run.

export const ATTR_RESCAN_DELAY_MS = 100;
export const ATTR_RECENT_MS = 1000;

export type RescanScheduler = {
  runNow(): void;
  noteAttributeChange(): void;
  flushForFocus(): boolean;
  cancel(): void;
};

export function createRescanScheduler(
  rescan: () => void,
  opts: { delayMs: number; recentMs: number },
): RescanScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastNotedAt = 0;

  function runNow(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    rescan();
  }

  // Arms the trailing timer only when none is armed — a burst of attribute
  // mutations stamps the latest time but never pushes the deadline out.
  function noteAttributeChange(): void {
    lastNotedAt = Date.now();
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      rescan();
    }, opts.delayMs);
  }

  function flushForFocus(): boolean {
    const pending = timer !== null;
    const recent = Date.now() - lastNotedAt < opts.recentMs;
    if (!pending && !recent) return false;
    runNow();
    return true;
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { runNow, noteAttributeChange, flushForFocus, cancel };
}
