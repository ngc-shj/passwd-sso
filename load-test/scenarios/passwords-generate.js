/**
 * k6 scenario: Generate password.
 *
 * POST /api/passwords/generate — authenticated, lightweight endpoint.
 * Rate limit: 120 per 60 seconds per user (2 req/s).
 *
 * Sustainable throughput = seeded users × 2 req/s.
 *   50 users (default) → 100 rps capacity, testing at 50 rps.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";
import { setSessionCookie } from "../helpers/auth.js";

export const options = {
  scenarios: {
    generate: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<100", "p(99)<300"],
    http_req_failed: ["rate<0.001"],
    checks: ["rate>0.999"],
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

  sleep(0.1);
}
