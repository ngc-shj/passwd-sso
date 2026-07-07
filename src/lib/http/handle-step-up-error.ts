import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import type { MainApiErrorBody } from "@/lib/http/api-response";

/**
 * Shared client handler for the `SESSION_STEP_UP_REQUIRED` 403.
 *
 * Every mutating-UI caller of a step-up-gated route (a route that calls
 * `requireRecentCurrentAuthMethod` server-side) must, on a stale window, open the
 * reauth dialog instead of surfacing a generic error. Before this helper each
 * caller inlined the same 3–4 lines:
 *
 *   const body = await readApiErrorBody(res);
 *   if (body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
 *     await trigger(arg);
 *     return;
 *   }
 *
 * `handleStepUpError` centralizes that block. Call it from the `!res.ok` branch;
 * if it returns `true` the caller should return early (reauth is in flight),
 * otherwise fall through to its existing error handling.
 *
 * The predicate `isStepUpRequired` exists for callers that have already parsed
 * the body (or received the error code some other way) and only need the check.
 *
 * NOTE for the coverage guard (scripts/checks/check-step-up-client-coverage.sh):
 * this file is the single place the raw `SESSION_STEP_UP_REQUIRED` literal lives
 * on the client after commonization. The guard's client-side adjacency check
 * accepts a `handleStepUpError(` call token as an equivalent "branch present"
 * signal — see the guard header for the accepted token set.
 */
export function isStepUpRequired(body: MainApiErrorBody | null): boolean {
  return body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED;
}

/**
 * Read the error body from a non-ok `Response`; if it is a step-up 403, invoke
 * `trigger(arg)` (typically `useInlineReauth().triggerOnStaleError`) and return
 * `true`. Returns `false` for every other error so the caller can continue its
 * own handling.
 *
 * Single-target callers use `T = void` and pass no `arg`. Multi-target callers
 * (a component with several distinct gated mutations) pass a discriminator so
 * the post-reauth retry replays the correct mutation.
 */
export async function handleStepUpError<T = void>(
  res: Response,
  trigger: (arg: T) => Promise<void>,
  arg: T = undefined as T,
): Promise<boolean> {
  const body = await readApiErrorBody(res);
  if (!isStepUpRequired(body)) {
    return false;
  }
  await trigger(arg);
  return true;
}

/**
 * Error thrown by non-hook layers (e.g. the vault-list adapters) that cannot
 * open the reauth dialog themselves but must NOT swallow a step-up 403 into a
 * generic failure. A component consumer catches it, recognises `.code`, and
 * routes to `triggerOnStaleError` instead of a silent reload.
 *
 * Only the step-up-gated adapter methods throw this; ungated methods keep
 * throwing a plain `Error` so their consumers' generic handling is unchanged.
 */
export class StepUpRequiredError extends Error {
  readonly code = API_ERROR.SESSION_STEP_UP_REQUIRED;
  constructor() {
    super("SESSION_STEP_UP_REQUIRED");
    this.name = "StepUpRequiredError";
  }
}

export function isStepUpRequiredError(e: unknown): e is StepUpRequiredError {
  return e instanceof StepUpRequiredError;
}

/**
 * For non-hook async layers: if `res` is a step-up 403, throw
 * `StepUpRequiredError` (so a component consumer can catch and reauth);
 * otherwise return so the caller can throw its own domain error. Use in a
 * gated adapter method:
 *
 *   const res = await fetchApi(url, { method: "DELETE" });
 *   await throwIfStepUp(res);
 *   if (!res.ok) throw new Error("deletePermanently failed");
 */
export async function throwIfStepUp(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await readApiErrorBody(res);
  if (isStepUpRequired(body)) {
    throw new StepUpRequiredError();
  }
}
