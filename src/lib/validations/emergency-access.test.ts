import { describe, expect, it } from "vitest";
import {
  createEmergencyGrantSchema,
  acceptEmergencyGrantSchema,
  rejectEmergencyGrantSchema,
  confirmEmergencyGrantSchema,
  acceptEmergencyGrantByIdSchema,
  revokeEmergencyGrantSchema,
} from "@/lib/validations/emergency-access";
import {
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
  HEX_SALT_LENGTH,
} from "@/lib/validations/common";

const HEX_IV = "a".repeat(HEX_IV_LENGTH);
const HEX_AUTH_TAG = "b".repeat(HEX_AUTH_TAG_LENGTH);
const HEX_SALT = "c".repeat(HEX_SALT_LENGTH);

const validEncryptedPrivateKey = (): {
  ciphertext: string;
  iv: string;
  authTag: string;
} => ({
  ciphertext: "deadbeef",
  iv: HEX_IV,
  authTag: HEX_AUTH_TAG,
});

// ─── createEmergencyGrantSchema ──────────────────────────────

describe("createEmergencyGrantSchema", () => {
  const valid = { granteeEmail: "alice@example.com", waitDays: 7 };

  it("accepts valid input with waitDays=7", () => {
    expect(createEmergencyGrantSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts waitDays=14 and waitDays=30", () => {
    expect(createEmergencyGrantSchema.safeParse({ ...valid, waitDays: 14 }).success).toBe(true);
    expect(createEmergencyGrantSchema.safeParse({ ...valid, waitDays: 30 }).success).toBe(true);
  });

  it("rejects when granteeEmail is missing", () => {
    const { granteeEmail: _, ...rest } = valid;
    const result = createEmergencyGrantSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "granteeEmail")).toBe(true);
    }
  });

  it("rejects when waitDays is missing", () => {
    const { waitDays: _, ...rest } = valid;
    const result = createEmergencyGrantSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "waitDays")).toBe(true);
    }
  });

  it("rejects an invalid email address", () => {
    const result = createEmergencyGrantSchema.safeParse({
      ...valid,
      granteeEmail: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects waitDays not in {7, 14, 30}", () => {
    const result = createEmergencyGrantSchema.safeParse({ ...valid, waitDays: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer waitDays", () => {
    const result = createEmergencyGrantSchema.safeParse({ ...valid, waitDays: 7.5 });
    expect(result.success).toBe(false);
  });

  it("rejects when waitDays is a string", () => {
    const result = createEmergencyGrantSchema.safeParse({ ...valid, waitDays: "7" });
    expect(result.success).toBe(false);
  });
});

// ─── acceptEmergencyGrantSchema ──────────────────────────────

describe("acceptEmergencyGrantSchema", () => {
  const valid = (): {
    token: string;
    granteePublicKey: string;
    encryptedPrivateKey: { ciphertext: string; iv: string; authTag: string };
  } => ({
    token: "t".repeat(64),
    granteePublicKey: "pubkey-base64",
    encryptedPrivateKey: validEncryptedPrivateKey(),
  });

  it("accepts valid input", () => {
    expect(acceptEmergencyGrantSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects when token is missing", () => {
    const { token: _, ...rest } = valid();
    expect(acceptEmergencyGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when granteePublicKey is missing", () => {
    const { granteePublicKey: _, ...rest } = valid();
    expect(acceptEmergencyGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when encryptedPrivateKey is missing", () => {
    const { encryptedPrivateKey: _, ...rest } = valid();
    expect(acceptEmergencyGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty token", () => {
    const result = acceptEmergencyGrantSchema.safeParse({ ...valid(), token: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "token");
      expect(issue?.code).toBe("too_small");
    }
  });

  it("rejects token at max+1 length (129)", () => {
    const result = acceptEmergencyGrantSchema.safeParse({
      ...valid(),
      token: "x".repeat(129),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "token");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects granteePublicKey at max+1 length (513)", () => {
    const result = acceptEmergencyGrantSchema.safeParse({
      ...valid(),
      granteePublicKey: "p".repeat(513),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "granteePublicKey");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects encryptedPrivateKey.ciphertext at max+1 length (1025)", () => {
    const result = acceptEmergencyGrantSchema.safeParse({
      ...valid(),
      encryptedPrivateKey: {
        ...validEncryptedPrivateKey(),
        ciphertext: "c".repeat(1025),
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "encryptedPrivateKey" && i.path[1] === "ciphertext",
      );
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects encryptedPrivateKey.iv with wrong length", () => {
    const result = acceptEmergencyGrantSchema.safeParse({
      ...valid(),
      encryptedPrivateKey: {
        ...validEncryptedPrivateKey(),
        iv: "a".repeat(HEX_IV_LENGTH - 1),
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects encryptedPrivateKey.authTag with wrong length", () => {
    const result = acceptEmergencyGrantSchema.safeParse({
      ...valid(),
      encryptedPrivateKey: {
        ...validEncryptedPrivateKey(),
        authTag: "b".repeat(HEX_AUTH_TAG_LENGTH + 1),
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects when token is a number (type mismatch)", () => {
    const result = acceptEmergencyGrantSchema.safeParse({ ...valid(), token: 12345 });
    expect(result.success).toBe(false);
  });
});

// ─── rejectEmergencyGrantSchema ──────────────────────────────

describe("rejectEmergencyGrantSchema", () => {
  it("accepts valid token", () => {
    expect(rejectEmergencyGrantSchema.safeParse({ token: "t" }).success).toBe(true);
  });

  it("rejects empty token", () => {
    const result = rejectEmergencyGrantSchema.safeParse({ token: "" });
    expect(result.success).toBe(false);
  });

  it("rejects token at max+1 length (129)", () => {
    const result = rejectEmergencyGrantSchema.safeParse({ token: "x".repeat(129) });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "token");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects when token is missing", () => {
    expect(rejectEmergencyGrantSchema.safeParse({}).success).toBe(false);
  });

  it("rejects null", () => {
    expect(rejectEmergencyGrantSchema.safeParse(null).success).toBe(false);
  });
});

// ─── confirmEmergencyGrantSchema ─────────────────────────────

describe("confirmEmergencyGrantSchema", () => {
  const valid = (): {
    ownerEphemeralPublicKey: string;
    encryptedSecretKey: string;
    secretKeyIv: string;
    secretKeyAuthTag: string;
    hkdfSalt: string;
    wrapVersion: number;
  } => ({
    ownerEphemeralPublicKey: "ephemeral-pub-key",
    encryptedSecretKey: "encrypted-secret",
    secretKeyIv: HEX_IV,
    secretKeyAuthTag: HEX_AUTH_TAG,
    hkdfSalt: HEX_SALT,
    wrapVersion: 1,
  });

  it("accepts valid input without optional keyVersion", () => {
    expect(confirmEmergencyGrantSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts valid input with keyVersion", () => {
    const result = confirmEmergencyGrantSchema.safeParse({
      ...valid(),
      keyVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when ownerEphemeralPublicKey is missing", () => {
    const { ownerEphemeralPublicKey: _, ...rest } = valid();
    expect(confirmEmergencyGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when wrapVersion is missing", () => {
    const { wrapVersion: _, ...rest } = valid();
    expect(confirmEmergencyGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects ownerEphemeralPublicKey at max+1 length (513)", () => {
    const result = confirmEmergencyGrantSchema.safeParse({
      ...valid(),
      ownerEphemeralPublicKey: "x".repeat(513),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "ownerEphemeralPublicKey",
      );
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects encryptedSecretKey at max+1 length (513)", () => {
    const result = confirmEmergencyGrantSchema.safeParse({
      ...valid(),
      encryptedSecretKey: "x".repeat(513),
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported wrapVersion", () => {
    const result = confirmEmergencyGrantSchema.safeParse({ ...valid(), wrapVersion: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects keyVersion below 1", () => {
    const result = confirmEmergencyGrantSchema.safeParse({
      ...valid(),
      keyVersion: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects salt with wrong length", () => {
    const result = confirmEmergencyGrantSchema.safeParse({
      ...valid(),
      hkdfSalt: "c".repeat(HEX_SALT_LENGTH - 1),
    });
    expect(result.success).toBe(false);
  });
});

// ─── acceptEmergencyGrantByIdSchema ──────────────────────────

describe("acceptEmergencyGrantByIdSchema", () => {
  const valid = (): {
    granteePublicKey: string;
    encryptedPrivateKey: { ciphertext: string; iv: string; authTag: string };
  } => ({
    granteePublicKey: "pub-key",
    encryptedPrivateKey: validEncryptedPrivateKey(),
  });

  it("accepts valid input", () => {
    expect(acceptEmergencyGrantByIdSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects missing granteePublicKey", () => {
    const { granteePublicKey: _, ...rest } = valid();
    expect(acceptEmergencyGrantByIdSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty granteePublicKey", () => {
    const result = acceptEmergencyGrantByIdSchema.safeParse({
      ...valid(),
      granteePublicKey: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects granteePublicKey at max+1 length (513)", () => {
    const result = acceptEmergencyGrantByIdSchema.safeParse({
      ...valid(),
      granteePublicKey: "y".repeat(513),
    });
    expect(result.success).toBe(false);
  });
});

// ─── revokeEmergencyGrantSchema ──────────────────────────────

describe("revokeEmergencyGrantSchema", () => {
  it("defaults permanent to true when omitted", () => {
    const result = revokeEmergencyGrantSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permanent).toBe(true);
    }
  });

  it("accepts permanent=false", () => {
    const result = revokeEmergencyGrantSchema.safeParse({ permanent: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permanent).toBe(false);
    }
  });

  it("rejects non-boolean permanent (type mismatch)", () => {
    const result = revokeEmergencyGrantSchema.safeParse({ permanent: "true" });
    expect(result.success).toBe(false);
  });
});
