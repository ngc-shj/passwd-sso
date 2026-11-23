import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const { mockVerifyPassphraseVerifier, mockLogAuditAsync } = vi.hoisted(() => ({
  mockVerifyPassphraseVerifier: vi.fn(),
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  verifyPassphraseVerifier: mockVerifyPassphraseVerifier,
}));
vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/audit")>()),
  logAuditAsync: mockLogAuditAsync,
}));

import { checkStoredVerifier } from "./stored-verifier-server";

const STORED_HMAC = "a".repeat(64);
const CLIENT_HASH = "b".repeat(64);

function check(storedHmac: string | null = STORED_HMAC) {
  return checkStoredVerifier(createRequest("POST"), {
    userId: "user-1",
    tenantId: "tenant-1",
    clientVerifierHash: CLIENT_HASH,
    storedHmac,
    storedVersion: 3,
  });
}

describe("checkStoredVerifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not-set without verifying when no verifier is stored", async () => {
    expect(await check(null)).toBe("not-set");
    expect(mockVerifyPassphraseVerifier).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("returns ok when the verifier matches, checked against the stored version", async () => {
    mockVerifyPassphraseVerifier.mockReturnValue({ ok: true });

    expect(await check()).toBe("ok");
    expect(mockVerifyPassphraseVerifier).toHaveBeenCalledWith(CLIENT_HASH, STORED_HMAC, 3);
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("returns wrong without an audit row on a mismatch", async () => {
    mockVerifyPassphraseVerifier.mockReturnValue({ ok: false, reason: "WRONG_PASSPHRASE" });

    expect(await check()).toBe("wrong");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("returns wrong and writes one VERIFIER_PEPPER_MISSING tenant audit when the pepper is missing", async () => {
    mockVerifyPassphraseVerifier.mockReturnValue({ ok: false, reason: "MISSING_PEPPER_VERSION" });

    expect(await check()).toBe("wrong");
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TENANT,
        userId: "user-1",
        tenantId: "tenant-1",
        action: AUDIT_ACTION.VERIFIER_PEPPER_MISSING,
        metadata: { storedVersion: 3 },
      }),
    );
  });
});
