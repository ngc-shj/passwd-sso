/**
 * k6 scenario: Health check endpoint.
 *
 * GET /api/health/ready — no authentication required.
 * Validates DB + Redis readiness under sustained load.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";

export const options = {
  scenarios: {
    health: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<200", "p(99)<500"],
    http_req_failed: ["rate<0.001"],
    checks: ["rate>0.999"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/health/ready`);

  check(res, {
    "status 200": (r) => r.status === 200,
    "db healthy": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.checks?.db?.status === "healthy";
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
