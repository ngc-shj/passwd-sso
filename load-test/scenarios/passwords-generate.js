/**
 * k6 scenario: Generate password.
 *
 * POST /api/passwords/generate — authenticated, lightweight endpoint.
 * Rate limit: 30 per 60 seconds per user.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";
import { setSessionCookie } from "../helpers/auth.js";

export const options = {
  scenarios: {
    generate: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 20 },
        { duration: "20s", target: 20 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<100", "p(99)<300"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  setSessionCookie();

  const res = http.post(
    `${BASE_URL}/api/passwords/generate`,
    JSON.stringify({
      mode: "password",
      length: 32,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "!@#$%",
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status 200": (r) => r.status === 200,
    "password length >= 32": (r) => {
      try {
        return JSON.parse(r.body).password.length >= 32;
      } catch {
        return false;
      }
    },
  });

  // Rate limit: 30/60s per user → max 1 req/2s per VU
  sleep(2);
}
