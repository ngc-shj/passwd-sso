/**
 * k6 scenario: Vault unlock.
 *
 * POST /api/vault/unlock — authenticated, sends correct authHash.
 * Rate limit: 5 attempts / 5 minutes per user.
 * Strategy: distribute 50 users across VUs + sleep to avoid rate limits.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";
import { getUser, setSessionCookie } from "../helpers/auth.js";

export const options = {
  scenarios: {
    unlock: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 20 },
        { duration: "30s", target: 20 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  setSessionCookie();
  const user = getUser();

  const res = http.post(
    `${BASE_URL}/api/vault/unlock`,
    JSON.stringify({ authHash: user.authHash }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status 200": (r) => r.status === 200,
    "valid true": (r) => {
      try {
        return JSON.parse(r.body).valid === true;
      } catch {
        return false;
      }
    },
    "has encryptedSecretKey": (r) => {
      try {
        return typeof JSON.parse(r.body).encryptedSecretKey === "string";
      } catch {
        return false;
      }
    },
  });

  // Sleep to stay under rate limit (5 per 5 min per user)
  sleep(1);
}
