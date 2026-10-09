import { vi } from "vitest";

type Injection = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean };
  func?: unknown;
  args?: unknown[];
  files?: string[];
};

export const documentIdFor = (frameId: number): string => `doc-${frameId}`;

/**
 * chrome.scripting.executeScript as the content-bundle probe sees it: a `func`
 * call without `args` (the location probe) gets one result per targeted frame,
 * carrying that frame's documentId and `url()`; every other call resolves [].
 */
export function createExecuteScriptMock(url: () => string = () => "https://example.com/login") {
  return vi.fn(async (injection: Injection) => {
    if (injection.func && !injection.args) {
      const frameIds = injection.target.frameIds ?? [0];
      return frameIds.map((frameId) => ({
        frameId,
        documentId: documentIdFor(frameId),
        result: url(),
      }));
    }
    return [];
  });
}
