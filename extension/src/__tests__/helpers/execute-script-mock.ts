import { vi } from "vitest";

type Injection = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean };
  func?: unknown;
  args?: unknown[];
  files?: string[];
};

export function probeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

export const documentIdFor = (frameId: number): string => `doc-${frameId}`;

/**
 * chrome.scripting.executeScript as the content-bundle probe sees it: a `func`
 * call without `args` (the location probe; the direct-autofill func always
 * passes args) gets one InjectionResult per targeted frame — every frame in
 * `frames` for an `allFrames` target, frame 0 for a bare `{ tabId }` — carrying
 * that frame's documentId and a `{ href, origin }` result: `urlFor(frameId)` and
 * `originFor(frameId)`, which defaults to the URL's own origin ("null" for
 * about: URLs). Every other call resolves [].
 */
export function createExecuteScriptMock(
  urlFor: (frameId: number) => string = () => "https://example.com/login",
  frames: () => number[] = () => [0],
  originFor: (frameId: number) => string = (frameId) => probeOrigin(urlFor(frameId)),
) {
  return vi.fn(async (injection: Injection) => {
    if (injection.func && !injection.args) {
      const frameIds = injection.target.allFrames
        ? frames()
        : (injection.target.frameIds ?? [0]);
      return frameIds.map((frameId) => ({
        frameId,
        documentId: documentIdFor(frameId),
        result: { href: urlFor(frameId), origin: originFor(frameId) },
      }));
    }
    return [];
  });
}
