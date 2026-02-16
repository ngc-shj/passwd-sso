/**
 * Auth helpers for k6 load test scenarios.
 *
 * Reads session credentials from the seed output file and assigns
 * one user per VU (virtual user) round-robin.
 */
import { SharedArray } from "k6/data";
import http from "k6/http";
import { BASE_URL, COOKIE_NAME } from "./config.js";

/**
 * Load seeded user credentials from JSON file.
 * SharedArray ensures the data is parsed once and shared across VUs.
 */
const users = new SharedArray("load-test-users", function () {
  const path = __ENV.AUTH_FILE || "load-test/setup/.load-test-auth.json";
  const data = JSON.parse(open(path));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      "No users in auth file. Run 'npm run test:load:seed' first.",
    );
  }
  return data;
});

/**
 * Get the user assigned to the current VU (round-robin).
 * @returns {{ userId: string, sessionToken: string, authHash: string }}
 */
export function getUser() {
  const idx = (__VU - 1) % users.length;
  return users[idx];
}

/**
 * Set the session cookie for the current VU.
 * Must be called in the default function or setup.
 */
export function setSessionCookie() {
  const user = getUser();
  const jar = http.cookieJar();
  jar.set(BASE_URL, COOKIE_NAME, user.sessionToken);
}
