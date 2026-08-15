import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_VALUES,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_ACTION_GROUPS_TENANT,
} from "@/lib/constants";

describe("AUDIT_ACTION group coverage", () => {
  it("every AUDIT_ACTION_VALUES entry is registered in at least one group", () => {
    const inAnyGroup = new Set([
      ...Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TEAM).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TENANT).flat(),
    ]);
    const missing = AUDIT_ACTION_VALUES.filter((a) => !inAnyGroup.has(a));
    expect(missing).toEqual([]);
  });

  // The check above is satisfied by membership in ANY of the three scope maps,
  // so a personal-scope action filed under _TEAM or _TENANT keeps it green while
  // never reaching the personal audit-log UI that is supposed to render it.
  // Actions whose scope is part of a contract are pinned here explicitly.
  it("personal-scope actions are registered in the PERSONAL group, not merely in some group", () => {
    const personalOnly = [
      AUDIT_ACTION.AUTH_PASSKEY_REAUTH,
      AUDIT_ACTION.AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH,
      AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
    ];
    const inPersonal = new Set(
      Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
    );
    const misfiled = personalOnly.filter((a) => !inPersonal.has(a));
    expect(misfiled).toEqual([]);
  });
});
