/**
 * Request header naming the user the web app's page believes it is acting
 * for. Set by `fetchApi` once the page knows its session user; checked by the
 * proxy's expected-user gate against the user the session cookie resolves to.
 * Kept free of node:* imports: the proxy bundle and client code import it.
 */
export const EXPECTED_USER_HEADER = "x-passwd-expected-user";
