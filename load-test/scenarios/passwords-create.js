/**
 * k6 scenario: Create password entry.
 *
 * POST /api/passwords — authenticated, sends fake encrypted payload.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";
import { setSessionCookie } from "../helpers/auth.js";
import { fakeCreatePasswordPayload } from "../helpers/data.js";

export const options = {
  scenarios: {
    create: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "20s", target: 10 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.005"],
    checks: ["rate>0.995"],
  },
};

export default function () {
  setSessionCookie();

  const payload = fakeCreatePasswordPayload();

  const res = http.post(
    `${BASE_URL}/api/passwords`,
    JSON.stringify(payload),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status 201": (r) => r.status === 201,
    "has id": (r) => {
      try {
        return typeof JSON.parse(r.body).id === "string";
      } catch {
        return false;
      }
    },
  });

  sleep(0.5);
}
