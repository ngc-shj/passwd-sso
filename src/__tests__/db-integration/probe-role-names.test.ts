import { describe, it, expect } from "vitest";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/constants/time";
import { PROBE_ROLE_PREFIX, probeRoleName, staleProbeRoles } from "./probe-role-names";

const NOW = 1_800_000_000_000;
const HEX = "0123456789ab";

describe("staleProbeRoles", () => {
  it("keeps a probe created minutes ago, so a concurrent run keeps its role", () => {
    const fresh = probeRoleName(NOW - 5 * MS_PER_MINUTE, HEX);
    expect(staleProbeRoles([fresh], NOW)).toEqual([]);
  });

  it("selects a probe older than an hour", () => {
    const old = probeRoleName(NOW - MS_PER_HOUR - 1, HEX);
    expect(staleProbeRoles([old], NOW)).toEqual([old]);
  });

  it("keeps a probe exactly an hour old", () => {
    const edge = probeRoleName(NOW - MS_PER_HOUR, HEX);
    expect(staleProbeRoles([edge], NOW)).toEqual([]);
  });

  it("ignores a role that does not carry the prefix", () => {
    expect(staleProbeRoles(["passwd_app", "postgres", `other_${NOW - 2 * MS_PER_HOUR}_${HEX}`], NOW)).toEqual([]);
  });

  it("ignores a prefixed name whose timestamp or suffix is malformed", () => {
    const malformed = [
      `${PROBE_ROLE_PREFIX}`,
      `${PROBE_ROLE_PREFIX}abc_${HEX}`,
      `${PROBE_ROLE_PREFIX}1_${HEX}`,
      `${PROBE_ROLE_PREFIX}${NOW - 2 * MS_PER_HOUR}`,
      `${PROBE_ROLE_PREFIX}${NOW - 2 * MS_PER_HOUR}_zz`,
      `${PROBE_ROLE_PREFIX}${NOW - 2 * MS_PER_HOUR}_${HEX}_extra`,
    ];
    expect(staleProbeRoles(malformed, NOW)).toEqual([]);
  });

  it("selects only the old one of a mixed list", () => {
    const old = probeRoleName(NOW - 3 * MS_PER_HOUR, HEX);
    const fresh = probeRoleName(NOW - MS_PER_MINUTE, "ba9876543210");
    expect(staleProbeRoles([fresh, "postgres", old], NOW)).toEqual([old]);
  });
});
