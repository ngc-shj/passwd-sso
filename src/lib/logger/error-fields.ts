export type ErrorLogFields = {
  name: string;
  code: string;
};

/**
 * Reduce an unknown caught value to bounded, non-narrative log fields.
 *
 * Error objects must not be handed to pino: its serializer includes message
 * and stack, which can carry connection targets, role names, URLs, and other
 * operational details. Keep only token-shaped names/codes so a hostile custom
 * Error cannot move free-form text back into the log through either field.
 */
export function errorLogFields(error: unknown): ErrorLogFields {
  let name = "unknown";
  let code = "unknown";

  try {
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
      name = error.name;
    }

    if (typeof error === "object" && error !== null && "code" in error) {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(candidate)) {
        code = candidate;
      }
    }
  } catch {
    // A caught value may expose throwing name/code getters. Logging the failure
    // must never replace the original control flow with a second exception.
  }

  return { name, code };
}
