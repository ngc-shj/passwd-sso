import { API_ERROR, apiErrorToI18nKey, type ApiErrorCode } from "./api-error-codes";

/**
 * Allow-list of API error codes that may be displayed to the end user via the
 * ApiErrors namespace from any settings card whose underlying route is guarded
 * by `requireRecentSession`. Codes outside this list MUST NOT bypass the
 * caller's domain-generic toast — even if `apiErrorToI18nKey` happens to know
 * how to translate them, the caller's surface did not opt in to displaying
 * them. (See feedback_subagent_findings_essence_filter.md and
 * docs/archive/review/unify-new-creation-ui-plan.md C6.)
 *
 * Per-component domain codes (quota limits, name conflicts, validation field
 * paths, recent-session aliases like `OPERATOR_TOKEN_STALE_SESSION`) are NOT
 * in this list — each card handles its own domain codes BEFORE consulting the
 * shared helper.
 */
const TOKEN_MINT_ALLOWLIST = new Set<ApiErrorCode>([
  API_ERROR.SESSION_STEP_UP_REQUIRED,
  API_ERROR.RATE_LIMIT_EXCEEDED,
]);

/**
 * Aliases — recent-session codes that route owners chose to name specifically
 * (e.g. operator-token uses `OPERATOR_TOKEN_STALE_SESSION`) but that should
 * surface the SAME re-authentication guidance as `SESSION_STEP_UP_REQUIRED`
 * per the C5 unification.
 */
const TOKEN_MINT_ALIASES: Record<string, string> = {
  [API_ERROR.OPERATOR_TOKEN_STALE_SESSION]: "sessionStepUpRequired",
};

/**
 * Translate a token-mint API error code into its ApiErrors i18n key, or
 * return null when the code is not on the shared allow-list. The caller is
 * expected to fall back to its own domain-generic toast in the null case.
 */
export function tokenMintApiErrorKey(error: unknown): string | null {
  if (typeof error !== "string") return null;
  if (error in TOKEN_MINT_ALIASES) return TOKEN_MINT_ALIASES[error];
  if ((TOKEN_MINT_ALLOWLIST as Set<string>).has(error)) {
    return apiErrorToI18nKey(error);
  }
  return null;
}
