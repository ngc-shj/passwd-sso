import { describe, it, expect } from "vitest";
import { resolveActorDisplay } from "./audit-display";
import {
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
} from "@/lib/constants/app";

describe("resolveActorDisplay", () => {
  it("returns 'actorTypeAnonymous' for ANONYMOUS_ACTOR_ID sentinel", () => {
    expect(resolveActorDisplay(ANONYMOUS_ACTOR_ID)).toBe("actorTypeAnonymous");
  });

  it("returns 'actorTypeSystem' for SYSTEM_ACTOR_ID sentinel", () => {
    expect(resolveActorDisplay(SYSTEM_ACTOR_ID)).toBe("actorTypeSystem");
  });

  it("returns null for a real user UUID", () => {
    // canonical RFC4122-shaped UUID, not a sentinel
    expect(resolveActorDisplay("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  it("returns null for an empty string (not a sentinel)", () => {
    expect(resolveActorDisplay("")).toBeNull();
  });

  it("returns null for arbitrary text", () => {
    expect(resolveActorDisplay("admin")).toBeNull();
  });

  it("treats sentinel match as exact (no prefix match)", () => {
    expect(resolveActorDisplay(`${ANONYMOUS_ACTOR_ID}x`)).toBeNull();
    expect(resolveActorDisplay(` ${SYSTEM_ACTOR_ID}`)).toBeNull();
  });

  it.each([
    [ANONYMOUS_ACTOR_ID, "actorTypeAnonymous"],
    [SYSTEM_ACTOR_ID, "actorTypeSystem"],
  ])("table-driven: %s → %s", (input, expected) => {
    expect(resolveActorDisplay(input)).toBe(expected);
  });
});
