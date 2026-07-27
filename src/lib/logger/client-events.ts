/**
 * The closed vocabulary of client-side log events.
 *
 * `clientLogWarn` / `clientLogError` accept only these ids, not `string`. That
 * is the enforcement: a template literal, a variable, or a concatenation is a
 * compile error rather than something a lint rule has to notice. An earlier
 * attempt used an ESLint selector on the callee name and was trivially bypassed
 * by an aliased import (`import { clientLogError as log }`), a variable, or a
 * wrapper — a detector always has one more spelling it has not seen, whereas an
 * unassignable type has none.
 *
 * Adding an event means adding a line here, which is visible in review.
 */
export const CLIENT_LOG_EVENT = {
  WEBAUTHN_REGISTRATION_FAILED: "webauthn.registration_failed",
  TEAM_KEY_ROTATION_FAILED: "team.key_rotation_failed",
  VAULT_ENTRY_DETAIL_FAILED: "vault.entry_detail_failed",
  I18N_NAMESPACE_MISSING: "i18n.namespace_missing",
  TEAM_MEMBER_KEY_REQUEST_FAILED: "team.member_key_request_failed",
  TEAM_MEMBER_KEY_VERSION_MISMATCH: "team.member_key_version_mismatch",
  TEAM_ENCRYPTION_KEY_FAILED: "team.encryption_key_failed",
  BASE_PATH_MALFORMED: "url.base_path_malformed",
} as const;

export type ClientLogEvent =
  (typeof CLIENT_LOG_EVENT)[keyof typeof CLIENT_LOG_EVENT];

/**
 * The closed vocabulary of error causes.
 *
 * Free-form exception text must never reach a browser console: `Error.message`
 * is attacker- or server-influenced, and this codebase's `describeUnknownError`
 * additionally concatenates `String(e.cause)`. A key-name denylist cannot help,
 * because it inspects keys and the secret would be inside the *value* — e.g.
 * `"authentication failed: password=hunter2"` or a URL carrying `?token=…`.
 *
 * So exceptions are normalized to one of these codes before logging. The
 * mapping is deliberately coarse: a client console is for "which branch failed",
 * not for diagnosing the failure. Full detail stays server-side, where pino
 * redacts by key and the sink is not readable by page scripts or extensions.
 */
export const CLIENT_ERROR_CODE = {
  ABORTED: "aborted",
  NOT_ALLOWED: "not_allowed",
  INVALID_STATE: "invalid_state",
  NOT_SUPPORTED: "not_supported",
  NETWORK: "network",
  DECRYPT: "decrypt",
  MALFORMED_RESPONSE: "malformed_response",
  UNKNOWN: "unknown",
} as const;

export type ClientErrorCode =
  (typeof CLIENT_ERROR_CODE)[keyof typeof CLIENT_ERROR_CODE];

/**
 * Named steps of the team-key derivation chain.
 *
 * Logged so a failure can be located without shipping the exception text. A
 * closed set rather than a free string, for the same reason as the codes above:
 * anything assignable from `string` is a channel for an interpolated secret.
 */
export const CLIENT_LOG_STAGE = {
  FETCH_MEMBER_KEY: "fetch_member_key",
  PARSE_MEMBER_KEY: "parse_member_key",
  IMPORT_ECDH_PRIVATE_KEY: "import_ecdh_private_key",
  UNWRAP_TEAM_KEY: "unwrap_team_key",
  DERIVE_TEAM_ENCRYPTION_KEY: "derive_team_encryption_key",
} as const;

export type ClientLogStage =
  (typeof CLIENT_LOG_STAGE)[keyof typeof CLIENT_LOG_STAGE];

/**
 * An explicitly bounded string. Construct with {@link opaque}, whose contract
 * is: the value contains no user input, no server text, and no URL query.
 *
 * Branded with a module-private symbol rather than a visible property. An
 * earlier version used `{ readonly __opaque: string }`, which had three
 * problems: the emitted log value became an object (contradicting "flat values
 * only" and changing the field shape downstream consumers see), and the shape
 * was public, so `{ __opaque: `token=${secret}` }` assigned cleanly and skipped
 * the truncation entirely. The symbol is not exported, so the brand cannot be
 * produced structurally — `opaque()` is the only way in — and at runtime the
 * value stays an ordinary string.
 */
declare const opaqueBrand: unique symbol;

export type Opaque = string & { readonly [opaqueBrand]: true };

/**
 * Mark a string as safe to log. Truncates as a backstop — an id that grew into
 * a serialized blob still cannot flood the console.
 */
export function opaque(value: string, maxLength = 64): Opaque {
  return value.slice(0, maxLength) as Opaque;
}

/**
 * The exact field set each event may carry.
 *
 * This is the primary defence, and it is a KEY allowlist — the value-type
 * restriction alone is not one. `ClientLogValue` narrows what a field may
 * hold, but says nothing about which fields exist, so `{ otp: 123456 }` and
 * `{ detail: opaque(secret) }` both typechecked under it. Enumerating the keys
 * per event closes that: an unlisted key is a compile error, and adding one is
 * a line in this table that a reviewer sees.
 *
 * `CLIENT_REDACT_KEYS` stays as the sink-side layer beneath this. It catches
 * what the type system cannot see — a cast, a call from untyped JavaScript, a
 * future widening of these types — and the fact that it grows over time is
 * fine for a safety net, which is not where the guarantee comes from.
 */
export type ClientLogPayloads = {
  [CLIENT_LOG_EVENT.WEBAUTHN_REGISTRATION_FAILED]: {
    code: ClientErrorCode;
  };
  [CLIENT_LOG_EVENT.TEAM_KEY_ROTATION_FAILED]: {
    code: ClientErrorCode;
  };
  [CLIENT_LOG_EVENT.VAULT_ENTRY_DETAIL_FAILED]: {
    code: ClientErrorCode;
  };
  [CLIENT_LOG_EVENT.I18N_NAMESPACE_MISSING]: {
    namespace: Opaque;
  };
  [CLIENT_LOG_EVENT.TEAM_MEMBER_KEY_REQUEST_FAILED]: {
    teamId: Opaque;
    status: number;
    error: Opaque;
  };
  [CLIENT_LOG_EVENT.TEAM_MEMBER_KEY_VERSION_MISMATCH]: {
    teamId: Opaque;
    requestedVersion: number;
    responseVersion: number;
  };
  [CLIENT_LOG_EVENT.TEAM_ENCRYPTION_KEY_FAILED]: {
    teamId: Opaque;
    stage: ClientLogStage;
    code: ClientErrorCode;
  };
  [CLIENT_LOG_EVENT.BASE_PATH_MALFORMED]: {
    firstSegment: Opaque;
  };
};

/**
 * Classify an unknown throwable into a loggable code.
 *
 * Reads only the error's *shape* (constructor, DOMException name) — never its
 * message, and never `cause`. Anything unrecognized becomes `unknown` rather
 * than leaking its text, so the default is safe.
 */
export function toClientErrorCode(e: unknown): ClientErrorCode {
  if (e instanceof DOMException) {
    switch (e.name) {
      case "AbortError":
        return CLIENT_ERROR_CODE.ABORTED;
      case "NotAllowedError":
        return CLIENT_ERROR_CODE.NOT_ALLOWED;
      case "InvalidStateError":
        return CLIENT_ERROR_CODE.INVALID_STATE;
      case "NotSupportedError":
        return CLIENT_ERROR_CODE.NOT_SUPPORTED;
      case "OperationError":
        return CLIENT_ERROR_CODE.DECRYPT;
      default:
        return CLIENT_ERROR_CODE.UNKNOWN;
    }
  }
  if (e instanceof TypeError) {
    // fetch() rejects with TypeError on network failure.
    return CLIENT_ERROR_CODE.NETWORK;
  }
  if (e instanceof SyntaxError) {
    // JSON.parse on a malformed response body.
    return CLIENT_ERROR_CODE.MALFORMED_RESPONSE;
  }
  return CLIENT_ERROR_CODE.UNKNOWN;
}
