export async function register() {
  // Validate environment variables at server startup.
  // Throws with a detailed error listing ALL invalid/missing vars.
  // Does NOT run during `next build` — only `next dev` and `next start`.
  await import("@/lib/env");
}
