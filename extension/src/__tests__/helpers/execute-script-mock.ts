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

// Reverse of documentIdFor: the frame a `documentIds` probe target names, so a
// documentId-addressed probe (the C2 content path, and any fallback probe that
// re-checks a documentId) can answer from the same per-frame data a frameIds
// probe uses. An id outside this helper's own minting (anything not `doc-<n>`)
// is unknown.
function frameIdOfDocument(documentId: string): number | null {
  const m = /^doc-(\d+)$/.exec(documentId);
  return m ? Number(m[1]) : null;
}

export type ProbeAnswer = { documentId: string; href: string; origin: string };

/**
 * chrome.scripting.executeScript as the content-bundle probe sees it: a `func`
 * call without `args` (the location probe; the direct-autofill func always
 * passes args) gets one InjectionResult per targeted frame — every frame in
 * `frames` for an `allFrames` target, the named frames for a `frameIds`
 * target, or the frame a `documentIds` target's id was minted for — carrying
 * that frame's documentId and a `{ href, origin }` result: `urlFor(frameId)`
 * and `originFor(frameId)`, which defaults to the URL's own origin ("null" for
 * about: URLs). Every other call resolves [].
 *
 * Two knobs let a test go past that per-frame default:
 * - `queueFrameAnswer(frameId, answer)` sets what the NEXT probe of that frame
 *   returns (consumed once, FIFO across repeated calls), independently of the
 *   frame's steady-state answer — a document a frame held at an earlier probe
 *   does not have to be the one it holds at a later one (navigation). `null`
 *   means the frame currently resolves no document (gone).
 * - `setDocumentAnswer(documentId, answer)` fixes what a `documentIds` probe
 *   for exactly that id returns, bypassing the frame lookup entirely. `null`
 *   means that id resolves to no document — Chrome returns no InjectionResult
 *   for a document that no longer exists, so a stale `documentIds: [id]`
 *   probe (the C2 fallback re-check after a navigation) must see the same.
 *
 * Neither knob is consulted unless a test calls it, so default behaviour (one
 * steady `doc-<frameId>` document per frame) is unchanged.
 */
export function createExecuteScriptMock(
  urlFor: (frameId: number) => string = () => "https://example.com/login",
  frames: () => number[] = () => [0],
  originFor: (frameId: number) => string = (frameId) => probeOrigin(urlFor(frameId)),
) {
  const frameAnswerQueues = new Map<number, Array<ProbeAnswer | null>>();
  const documentAnswers = new Map<string, ProbeAnswer | null>();

  function queueFrameAnswer(frameId: number, answer: ProbeAnswer | null): void {
    const queue = frameAnswerQueues.get(frameId) ?? [];
    queue.push(answer);
    frameAnswerQueues.set(frameId, queue);
  }

  function setDocumentAnswer(documentId: string, answer: ProbeAnswer | null): void {
    documentAnswers.set(documentId, answer);
  }

  // The frame's current answer: the next queued override if one is pending,
  // else the frame's steady-state document.
  function answerForFrame(frameId: number): ProbeAnswer | null {
    const queue = frameAnswerQueues.get(frameId);
    if (queue && queue.length > 0) return queue.shift()!;
    return { documentId: documentIdFor(frameId), href: urlFor(frameId), origin: originFor(frameId) };
  }

  function toResult(frameId: number, answer: ProbeAnswer | null) {
    return answer ? [{ frameId, documentId: answer.documentId, result: { href: answer.href, origin: answer.origin } }] : [];
  }

  function answerForDocument(documentId: string) {
    if (documentAnswers.has(documentId)) {
      const answer = documentAnswers.get(documentId) ?? null;
      const frameId = frameIdOfDocument(documentId) ?? -1;
      return toResult(frameId, answer);
    }
    const frameId = frameIdOfDocument(documentId);
    if (frameId === null) return [];
    const answer = answerForFrame(frameId);
    // The frame no longer holds the document this id names (it navigated):
    // Chrome resolves no result for a documentId it cannot find.
    if (!answer || answer.documentId !== documentId) return [];
    return toResult(frameId, answer);
  }

  const mock = vi.fn(async (injection: Injection) => {
    if (injection.func && !injection.args) {
      if (injection.target.documentIds) {
        return injection.target.documentIds.flatMap((documentId) => answerForDocument(documentId));
      }
      const frameIds = injection.target.allFrames ? frames() : (injection.target.frameIds ?? [0]);
      return frameIds.flatMap((frameId) => toResult(frameId, answerForFrame(frameId)));
    }
    return [];
  });

  return Object.assign(mock, { queueFrameAnswer, setDocumentAnswer });
}
