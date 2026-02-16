/**
 * k6 scenario: List passwords.
 *
 * GET /api/passwords — authenticated, returns encrypted overviews.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";
import { setSessionCookie } from "../helpers/auth.js";

export const options = {
  scenarios: {
    list: {
      executor: "constant-arrival-rate",
      rate: 30,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<300", "p(99)<800"],
    http_req_failed: ["rate<0.001"],
    checks: ["rate>0.999"],
  },
};

export default function () {
  setSessionCookie();

  const res = http.get(`${BASE_URL}/api/passwords`);

  check(res, {
    "status 200": (r) => r.status === 200,
    "body is array": (r) => {
      try {
        return Array.isArray(JSON.parse(r.body));
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
