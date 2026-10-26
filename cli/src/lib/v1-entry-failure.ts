import { readApiErrorBody } from "./api-error-body.js";

/** The message `env` and `run` print when a v1 entry fetch is refused. */
export async function describeEntryFetchFailure(res: Response, entry: string): Promise<string> {
  const errorBody = await readApiErrorBody(res);
  if (errorBody?.error === "PASSKEY_REQUIRED") {
    return "This tenant requires a passkey to be registered in the browser.";
  }
  return `Failed to fetch entry ${entry}: HTTP ${res.status}`;
}
