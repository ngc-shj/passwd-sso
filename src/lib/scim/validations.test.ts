import { describe, it, expect } from "vitest";
import {
  scimUserSchema,
  scimPatchOpSchema,
  scimGroupSchema,
} from "./validations";

describe("scimUserSchema", () => {
  const validUser = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "test@example.com",
  };

  it("accepts a minimal valid user", () => {
    const result = scimUserSchema.safeParse(validUser);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userName).toBe("test@example.com");
      expect(result.data.active).toBe(true); // default
    }
  });

  it("normalizes userName to lowercase", () => {
    const result = scimUserSchema.safeParse({
      ...validUser,
      userName: "UPPER@EXAMPLE.COM",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userName).toBe("upper@example.com");
    }
  });

  it("accepts user with all optional fields", () => {
    const result = scimUserSchema.safeParse({
      ...validUser,
      externalId: "ext-1",
      name: { formatted: "John Doe", givenName: "John", familyName: "Doe" },
      active: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.externalId).toBe("ext-1");
      expect(result.data.name?.formatted).toBe("John Doe");
      expect(result.data.active).toBe(false);
    }
  });

  it("rejects missing schemas", () => {
    const result = scimUserSchema.safeParse({ userName: "test@example.com" });
    expect(result.success).toBe(false);
  });

  it("rejects wrong schema URN", () => {
    const result = scimUserSchema.safeParse({
      schemas: ["urn:wrong:schema"],
      userName: "test@example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing userName", () => {
    const result = scimUserSchema.safeParse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email format", () => {
    const result = scimUserSchema.safeParse({
      ...validUser,
      userName: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects userName exceeding max length", () => {
    const result = scimUserSchema.safeParse({
      ...validUser,
      userName: `${"a".repeat(250)}@example.com`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects externalId exceeding max length", () => {
    const result = scimUserSchema.safeParse({
      ...validUser,
      externalId: "x".repeat(256),
    });
    expect(result.success).toBe(false);
  });
});

describe("scimPatchOpSchema", () => {
  it("accepts a valid PatchOp request", () => {
    const result = scimPatchOpSchema.safeParse({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing PatchOp schema URN", () => {
    const result = scimPatchOpSchema.safeParse({
      schemas: ["urn:wrong"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty Operations array", () => {
    const result = scimPatchOpSchema.safeParse({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported op value", () => {
    const result = scimPatchOpSchema.safeParse({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "delete", path: "active" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects Operations exceeding max count of 100", () => {
    const ops = Array.from({ length: 101 }, () => ({
      op: "replace" as const,
      path: "active",
      value: false,
    }));
    const result = scimPatchOpSchema.safeParse({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: ops,
    });
    expect(result.success).toBe(false);
  });
});

describe("scimGroupSchema", () => {
  it("accepts a valid group", () => {
    const result = scimGroupSchema.safeParse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "ADMIN",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.members).toEqual([]); // default
    }
  });

  it("accepts group with members", () => {
    const result = scimGroupSchema.safeParse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "ADMIN",
      members: [{ value: "user-1" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.members).toHaveLength(1);
    }
  });

  it("rejects missing Group schema URN", () => {
    const result = scimGroupSchema.safeParse({
      schemas: ["urn:wrong"],
      displayName: "ADMIN",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty displayName", () => {
    const result = scimGroupSchema.safeParse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects members exceeding max count of 1000", () => {
    const members = Array.from({ length: 1001 }, (_, i) => ({
      value: `user-${i}`,
    }));
    const result = scimGroupSchema.safeParse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "ADMIN",
      members,
    });
    expect(result.success).toBe(false);
  });
});
