// Re-injection of the form-detector content bundle for frames whose manifest
// content script never ran (tab opened before install or before host
// permission was granted).
//
// The bundle path must come from the built manifest: CRXJS emits a loader
// (`assets/form-detector.ts-loader-<hash>.js` in production,
// `src/content/form-detector.ts-loader.js` in dev), and no
// `src/content/form-detector.js` exists in the build.
//
// Delivery is pinned to one document. A probe reads each target document's URL
// together with its documentId; documents outside the bundle's own manifest
// `matches` are refused (activeTab reaches pages the manifest deliberately does
// not match, such as plain http:// hosts), and the bundle and every resend go to
// the probed documentId, so a navigation in the frame during the resend window
// cannot receive the payload.

const CONTENT_BUNDLE_NAME = "form-detector";
const CONTENT_BUNDLE_LOADER_RE = /-loader(-[A-Za-z0-9_-]+)?\.js$/;

// The CRXJS loader starts the bundle with a dynamic import() that
// executeScript does not await, so the listener may not be registered yet when
// the injection resolves.
export const BUNDLE_RESEND_ATTEMPTS = 10;
export const BUNDLE_RESEND_INTERVAL_MS = 50;

export const CONTENT_BUNDLE_ERROR = {
  NOT_FOUND: "CONTENT_BUNDLE_NOT_FOUND",
  SCOPE_REFUSED: "CONTENT_BUNDLE_SCOPE_REFUSED",
  DOCUMENT_UNKNOWN: "CONTENT_BUNDLE_DOCUMENT_UNKNOWN",
} as const;

const NO_RECEIVER_RE = /Receiving end does not exist/;

type ContentBundle = { file: string; matches: readonly string[] };

function resolveContentBundle(): ContentBundle | null {
  const contentScripts = chrome.runtime.getManifest().content_scripts ?? [];
  for (const entry of contentScripts) {
    for (const file of entry.js ?? []) {
      if (file.includes(CONTENT_BUNDLE_NAME) && CONTENT_BUNDLE_LOADER_RE.test(file)) {
        return { file, matches: entry.matches ?? [] };
      }
    }
  }
  return null;
}

export function resolveContentBundlePath(): string | null {
  return resolveContentBundle()?.file ?? null;
}

const MATCH_PATTERN_RE = /^(https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Whether `url` falls inside a Chrome match pattern of the forms the manifest
 * uses (`<http|https>://<*|*.host|host>/<path glob>`; any port, as Chrome
 * matches). Any other pattern form matches nothing, so an unrecognised manifest
 * entry fails closed.
 */
export function matchesPattern(url: string, pattern: string): boolean {
  const m = MATCH_PATTERN_RE.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${scheme}:`) return false;
  const hostname = parsed.hostname;
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
  } else if (host !== "*" && hostname !== host) {
    return false;
  }
  return globToRegExp(path).test(parsed.pathname + parsed.search);
}

function isNoReceiverError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NO_RECEIVER_RE.test(message);
}

/**
 * Inject the content bundle into the in-scope documents of `target` and return
 * their documentIds. A target without `allFrames` names one frame and must
 * resolve to exactly one in-scope document. Throws (so the caller fails closed
 * with its own error code) when the bundle path is unknown, no target document
 * is in the bundle's manifest scope, or the frame's document cannot be pinned.
 */
export async function injectContentBundle(
  target: chrome.scripting.InjectionTarget,
): Promise<string[]> {
  const bundle = resolveContentBundle();
  if (!bundle) throw new Error(CONTENT_BUNDLE_ERROR.NOT_FOUND);
  const probes = await chrome.scripting.executeScript({
    target,
    func: () => location.href,
  });
  if (!target.allFrames && probes.length !== 1) {
    throw new Error(CONTENT_BUNDLE_ERROR.DOCUMENT_UNKNOWN);
  }
  const documentIds = probes
    .filter(
      (probe) =>
        typeof probe.result === "string" &&
        bundle.matches.some((pattern) => matchesPattern(probe.result as string, pattern)),
    )
    .map((probe) => probe.documentId);
  if (documentIds.length === 0) throw new Error(CONTENT_BUNDLE_ERROR.SCOPE_REFUSED);
  if (documentIds.some((id) => !id)) throw new Error(CONTENT_BUNDLE_ERROR.DOCUMENT_UNKNOWN);
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds },
    files: [bundle.file],
  });
  return documentIds;
}

/**
 * Deliver via `send`, retrying a "Receiving end does not exist" rejection up to
 * BUNDLE_RESEND_ATTEMPTS times, BUNDLE_RESEND_INTERVAL_MS apart; any other
 * rejection, or an exhausted budget, rejects.
 */
export async function resendUntilReceived<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      if (attempt >= BUNDLE_RESEND_ATTEMPTS || !isNoReceiverError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, BUNDLE_RESEND_INTERVAL_MS));
    }
  }
}

/**
 * Inject the bundle into `target`, then deliver via `send`. A frame target's
 * single documentId is handed to `send` so the resend reaches only the injected
 * document; an `allFrames` target hands `undefined`.
 */
export async function injectContentBundleAndResend<T>(
  target: chrome.scripting.InjectionTarget,
  send: (documentId: string | undefined) => Promise<T>,
): Promise<T> {
  const documentIds = await injectContentBundle(target);
  const documentId = target.allFrames ? undefined : documentIds[0];
  return resendUntilReceived(() => send(documentId));
}
