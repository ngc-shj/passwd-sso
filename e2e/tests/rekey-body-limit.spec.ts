/**
 * E2E: request bodies above the proxy's 10 MiB default reach their route whole
 * (docs/archive/review/team-key-rotation-rekey-plan.md C7, A8).
 *
 * Next's proxy does not reject a body above `proxyClientMaxBodySize`: it hands
 * the route a truncated one, which the route can only answer as malformed
 * JSON. `next.config.ts` raises the limit to the largest route body cap. Each
 * request here is well-formed and larger than the 10 MiB default, so the
 * route's own answer — a business refusal, not INVALID_JSON — proves it read
 * the whole body:
 *
 *   - a valid re-key POST (history blobs at CIPHERTEXT_MAX) with a stale
 *     snapshot → 409 REKEY_SNAPSHOT_MISMATCH;
 *   - a valid personal migrate PUT for an attachment that does not exist → 404.
 *
 * The limit is a property of a production build, and a server reused from
 * another checkout proves nothing about this one, so the spec refuses to run
 * unless Playwright builds and starts the server itself (CI, or
 * E2E_CSP_SERVER=prod with E2E_BASE_URL unset).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { configuredSessionCookieName } from "../../src/lib/auth/session/cookie-name";
import { getAuthState } from "../helpers/fixtures";
import { closePool, refreshSessionRecency } from "../helpers/db";
import {
  deleteSeededTeam,
  seedPendingTeamEntry,
  seedTeamAtKeyVersion,
  seedTeamKeyHolder,
  type SeededPendingTeamEntry,
} from "../helpers/team-rekey";
import {
  ATTACHMENT_BODY_BASE64_MAX,
  CIPHERTEXT_MAX,
  REKEY_BODY_MAX,
  REKEY_HISTORY_MAX,
} from "../../src/lib/validations/common";

/** Next's default proxyClientMaxBodySize. */
const PROXY_DEFAULT_BODY_MAX = 10 * 1024 * 1024;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const field = (ciphertext: string) => ({ ciphertext, iv: hex(12), authTag: hex(16) });

function assertOwnProductionServer(): void {
  const prodBuild = !!process.env.CI || process.env.E2E_CSP_SERVER === "prod";
  if (!prodBuild || process.env.E2E_BASE_URL) {
    throw new Error(
      "REKEY_BODY_LIMIT_SPEC_REFUSED: this spec needs the production server Playwright builds and starts " +
        "(set CI or E2E_CSP_SERVER=prod, and leave E2E_BASE_URL unset); a dev or reused server proves nothing about next.config.ts",
    );
  }
}

test.describe("request bodies above the proxy's 10 MiB default reach the route whole", () => {
  // A retry-passed test exits 0; a truncation that only sometimes happens must fail.
  test.describe.configure({ retries: 0 });

  const teamId = randomUUID();
  let entry: SeededPendingTeamEntry;
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    assertOwnProductionServer();
    const { teamOwner } = getAuthState();
    // A dedicated team at version 2 whose owner holds both versions, with
    // one entry whose ItemKey was created at version 1.
    await seedTeamAtKeyVersion({ id: teamId, name: "E2E Rekey Body Limit", slug: `e2e-rekey-${teamId.slice(0, 8)}`, teamKeyVersion: 2 });
    await seedTeamKeyHolder({ teamId, userId: teamOwner.id, role: "OWNER", keyVersions: [1, 2] });
    entry = await seedPendingTeamEntry({ teamId, createdById: teamOwner.id, teamKeyVersion: 2, itemKeyCreatedAt: 1 });
    await refreshSessionRecency(teamOwner.sessionToken);

    // Requests only: no browser. The session cookie and the Origin the proxy's
    // CSRF gate requires of a cookie-bearing mutation are sent as headers.
    const baseURL = test.info().project.use.baseURL;
    if (!baseURL) throw new Error("REKEY_BODY_LIMIT_SPEC_REFUSED: no baseURL");
    api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        Cookie: `${configuredSessionCookieName()}=${teamOwner.sessionToken}`,
        Origin: new URL(baseURL).origin,
      },
    });
  });

  test.afterAll(async () => {
    await api?.dispose();
    await deleteSeededTeam(teamId);
    await closePool();
  });

  test("a valid re-key POST above 10 MiB with a stale snapshot → 409 REKEY_SNAPSHOT_MISMATCH", async () => {
    const historyCount = Math.ceil((PROXY_DEFAULT_BODY_MAX + 1) / CIPHERTEXT_MAX) + 1;
    expect(historyCount).toBeGreaterThanOrEqual(21);
    expect(historyCount).toBeLessThanOrEqual(REKEY_HISTORY_MAX);
    const body = JSON.stringify({
      teamKeyVersion: 2,
      // Stale: the entry's blob IV is not this one.
      snapshot: { blobIv: hex(12), overviewIv: entry.overviewIv, itemKeyIv: entry.itemKeyIv, itemKeyVersion: entry.itemKeyVersion },
      newItemKeyVersion: 2,
      encryptedItemKey: field(hex(48)),
      encryptedBlob: field(hex(64)),
      encryptedOverview: field(hex(64)),
      aadVersion: 1,
      history: Array.from({ length: historyCount }, () => ({
        id: randomUUID(),
        snapshotBlobIv: hex(12),
        encryptedBlob: field("a".repeat(CIPHERTEXT_MAX)),
      })),
      retainHistoryIds: [],
      attachmentCekRewraps: [],
    });
    expect(body.length).toBeGreaterThan(PROXY_DEFAULT_BODY_MAX);
    expect(body.length).toBeLessThanOrEqual(REKEY_BODY_MAX);

    const res = await api.post(`/api/teams/${teamId}/passwords/${entry.id}/rekey`, {
      data: body,
      headers: { "Content-Type": "application/json" },
    });
    expect({ status: res.status(), body: await res.json() }).toEqual({
      status: 409,
      body: expect.objectContaining({ error: "REKEY_SNAPSHOT_MISMATCH" }),
    });
  });

  test("a well-formed personal migrate PUT above 10 MiB for an attachment that does not exist → 404", async () => {
    // Base64 of ~11 MB, under the route's own body cap.
    const encryptedData = "A".repeat(4 * Math.ceil((PROXY_DEFAULT_BODY_MAX + 512 * 1024) / 4));
    expect(encryptedData.length).toBeLessThanOrEqual(ATTACHMENT_BODY_BASE64_MAX);
    const body = JSON.stringify({
      oldEncryptedDataHash: hex(32),
      encryptedData,
      iv: hex(12),
      authTag: hex(16),
      cekEncrypted: Buffer.from(randomBytes(60)).toString("base64"),
      cekIv: hex(12),
      cekAuthTag: hex(16),
      cekKeyVersion: 1,
      cekWrapAadVersion: 1,
    });
    expect(body.length).toBeGreaterThan(PROXY_DEFAULT_BODY_MAX);

    const res = await api.put(`/api/passwords/${randomUUID()}/attachments/${randomUUID()}/migrate`, {
      data: body,
      headers: { "Content-Type": "application/json" },
    });
    expect({ status: res.status(), body: await res.json() }).toEqual({
      status: 404,
      body: expect.objectContaining({ error: "NOT_FOUND" }),
    });
  });
});
