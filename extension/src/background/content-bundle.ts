// Re-injection of the form-detector content bundle for frames whose manifest
// content script never ran (tab opened before install or before host
// permission was granted).
//
// The bundle path must come from the built manifest: CRXJS emits a loader
// (`assets/form-detector.ts-loader-<hash>.js` in production,
// `src/content/form-detector.ts-loader.js` in dev), and no
// `src/content/form-detector.js` exists in the build.

const CONTENT_BUNDLE_NAME = "form-detector";
const CONTENT_BUNDLE_LOADER_RE = /-loader(-[A-Za-z0-9_-]+)?\.js$/;

// The CRXJS loader starts the bundle with a dynamic import() that
// executeScript does not await, so the listener may not be registered yet when
// the injection resolves.
export const BUNDLE_RESEND_ATTEMPTS = 10;
export const BUNDLE_RESEND_INTERVAL_MS = 50;

const NO_RECEIVER_RE = /Receiving end does not exist/;

export function resolveContentBundlePath(): string | null {
  const contentScripts = chrome.runtime.getManifest().content_scripts ?? [];
  for (const entry of contentScripts) {
    for (const file of entry.js ?? []) {
      if (file.includes(CONTENT_BUNDLE_NAME) && CONTENT_BUNDLE_LOADER_RE.test(file)) {
        return file;
      }
    }
  }
  return null;
}

function isNoReceiverError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NO_RECEIVER_RE.test(message);
}

/**
 * Inject the content bundle into `target`, then deliver via `send`. A
 * "Receiving end does not exist" rejection is retried up to
 * BUNDLE_RESEND_ATTEMPTS times, BUNDLE_RESEND_INTERVAL_MS apart; any other
 * rejection, an unresolvable bundle path, or an exhausted budget rejects so the
 * caller fails closed with its own error code.
 */
export async function injectContentBundleAndResend<T>(
  target: chrome.scripting.InjectionTarget,
  send: () => Promise<T>,
): Promise<T> {
  const file = resolveContentBundlePath();
  if (!file) throw new Error("CONTENT_BUNDLE_NOT_FOUND");
  await chrome.scripting.executeScript({ target, files: [file] });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      if (attempt >= BUNDLE_RESEND_ATTEMPTS || !isNoReceiverError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, BUNDLE_RESEND_INTERVAL_MS));
    }
  }
}
