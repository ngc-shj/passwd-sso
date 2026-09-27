/**
 * Which server the E2E suite boots.
 *
 * Extracted from `playwright.config.ts` so it can be asserted: the config
 * itself is not importable under vitest (it `require.resolve`s the global
 * setup), and the property that matters here is easy to break in one specific
 * way that nothing else would catch.
 *
 * The CSP spec needs a production build — `csp-builder.ts` reads `NODE_ENV` at
 * module init and the dev policy carries `'unsafe-inline'`, under which every
 * violation that spec exists to catch is invisible. Adding a local opt-in for
 * that is easy to get wrong by REPLACING the `CI` condition instead of adding
 * to it, which would silently move every other spec onto `next dev` in CI,
 * where they have always run against a production build. Nothing in the suite
 * would fail; the subject would just quietly change.
 */
export const PROD_WEB_SERVER_COMMAND = "npm run build && npm start";
export const DEV_WEB_SERVER_COMMAND = "npx next dev --turbopack";

type WebServerEnv = { CI?: string; E2E_CSP_SERVER?: string };

export function resolveWebServerCommand(
  env: WebServerEnv = process.env as WebServerEnv,
): string {
  return env.CI || env.E2E_CSP_SERVER === "prod"
    ? PROD_WEB_SERVER_COMMAND
    : DEV_WEB_SERVER_COMMAND;
}
