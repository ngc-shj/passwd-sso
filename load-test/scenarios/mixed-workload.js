/**
 * k6 scenario: Mixed workload.
 *
 * Simulates realistic traffic distribution across all endpoints.
 * Traffic split: unlock 10%, list 50%, create 15%, generate 25%
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../helpers/config.js";
import { getUser, setSessionCookie } from "../helpers/auth.js";
import { fakeCreatePasswordPayload } from "../helpers/data.js";

export const options = {
  scenarios: {
    mixed: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "15s", target: 20 },
        { duration: "60s", target: 20 },
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_duration": ["p(95)<500", "p(99)<1500"],
    "http_req_duration{endpoint:unlock}": ["p(95)<500"],
    "http_req_duration{endpoint:list}": ["p(95)<300"],
    "http_req_duration{endpoint:create}": ["p(95)<500"],
    "http_req_duration{endpoint:generate}": ["p(95)<100"],
    "http_req_failed": ["rate<0.005"],
    "http_req_failed{endpoint:unlock}": ["rate<0.01"],
    "http_req_failed{endpoint:list}": ["rate<0.001"],
    "http_req_failed{endpoint:create}": ["rate<0.005"],
    "http_req_failed{endpoint:generate}": ["rate<0.001"],
    "checks": ["rate>0.995"],
  },
};

function doUnlock() {
  const user = getUser();
  const res = http.post(
    `${BASE_URL}/api/vault/unlock`,
    JSON.stringify({ authHash: user.authHash }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "unlock" },
    },
  );
  check(res, { "unlock 200": (r) => r.status === 200 });
}

function doList() {
  const res = http.get(`${BASE_URL}/api/passwords`, {
    tags: { endpoint: "list" },
  });
  check(res, { "list 200": (r) => r.status === 200 });
}

function doCreate() {
  const payload = fakeCreatePasswordPayload();
  const res = http.post(
    `${BASE_URL}/api/passwords`,
    JSON.stringify(payload),
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "create" },
    },
  );
  check(res, { "create 201": (r) => r.status === 201 });
}

function doGenerate() {
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
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "generate" },
    },
  );
  check(res, { "generate 200": (r) => r.status === 200 });
}

export default function () {
  setSessionCookie();

  // Traffic distribution: unlock 10%, list 50%, create 15%, generate 25%
  const rand = Math.random();
  if (rand < 0.10) {
    doUnlock();
  } else if (rand < 0.60) {
    doList();
  } else if (rand < 0.75) {
    doCreate();
  } else {
    doGenerate();
  }

  // Think time: 1-3 seconds
  sleep(1 + Math.random() * 2);
}
