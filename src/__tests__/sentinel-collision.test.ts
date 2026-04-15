import { describe, it, expect } from "vitest";
import {
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  SENTINEL_ACTOR_IDS,
  NIL_UUID,
  UUID_RE,
} from "@/lib/constants/app";

describe("sentinel UUID invariants", () => {
  it("ANONYMOUS_ACTOR_ID and SYSTEM_ACTOR_ID are distinct", () => {
    expect(ANONYMOUS_ACTOR_ID).not.toBe(SYSTEM_ACTOR_ID);
  });

  it("neither sentinel equals NIL_UUID", () => {
    expect(ANONYMOUS_ACTOR_ID).not.toBe(NIL_UUID);
    expect(SYSTEM_ACTOR_ID).not.toBe(NIL_UUID);
  });

  it("sentinels satisfy UUID_RE", () => {
    expect(UUID_RE.test(ANONYMOUS_ACTOR_ID)).toBe(true);
    expect(UUID_RE.test(SYSTEM_ACTOR_ID)).toBe(true);
  });

  it("SENTINEL_ACTOR_IDS contains both and only both", () => {
    expect(SENTINEL_ACTOR_IDS.has(ANONYMOUS_ACTOR_ID)).toBe(true);
    expect(SENTINEL_ACTOR_IDS.has(SYSTEM_ACTOR_ID)).toBe(true);
    expect(SENTINEL_ACTOR_IDS.size).toBe(2);
  });

  it("sentinels have UUIDv4 version nibble but are NOT random UUIDv4", () => {
    // Version nibble (14th hex char) = 4
    expect(ANONYMOUS_ACTOR_ID.charAt(14)).toBe("4");
    expect(SYSTEM_ACTOR_ID.charAt(14)).toBe("4");
    // Variant bits (19th char in [89ab]) = 8
    expect(ANONYMOUS_ACTOR_ID.charAt(19)).toBe("8");
    expect(SYSTEM_ACTOR_ID.charAt(19)).toBe("8");
  });
});
