/**
 * Unit cases for the migration preflight. `RoleProbe` is structural, so the
 * branches need no database — including the indeterminate one, which the
 * integration file structurally cannot reach because a real connection always
 * resolves a role.
 */
import { describe, it, expect } from "vitest";
import {
  assertRlsVisibility,
  checkRlsVisibility,
} from "../lib/assert-rls-visibility.ts";

const probe = (rows) => ({ $queryRawUnsafe: async () => rows });

describe("assertRlsVisibility", () => {
  it("refuses when the role can see neither by superuser nor by bypassrls", async () => {
    await expect(
      assertRlsVisibility(
        probe([{ role: "passwd_app", is_superuser: false, bypasses_rls: false }]),
        "subject",
      ),
    ).rejects.toThrow(/RLS_PREFLIGHT_FAILED/);
  });

  it.each([
    ["superuser", { is_superuser: true, bypasses_rls: false }],
    ["bypassrls", { is_superuser: false, bypasses_rls: true }],
  ])("permits a role that can see by %s", async (_label, attrs) => {
    // Both attributes bypass RLS unconditionally, including FORCE. Pinning
    // each separately keeps a fix that drops one from passing on the other.
    const v = await assertRlsVisibility(
      probe([{ role: "r", ...attrs }]),
      "subject",
    );
    expect(v.isSuperuser || v.bypassesRls).toBe(true);
  });

  it("refuses rather than assumes when the role cannot be resolved", async () => {
    // "Could not determine" must not be spelled like "determined it is fine".
    await expect(checkRlsVisibility(probe([]))).rejects.toThrow(
      /RLS_PREFLIGHT_INDETERMINATE/,
    );
  });

  it("names the offending role and the remedy", async () => {
    // An operator who cannot tell what to change re-runs the same command.
    await expect(
      assertRlsVisibility(
        probe([{ role: "passwd_app", is_superuser: false, bypasses_rls: false }]),
        "migrate-account-tokens-to-encrypted",
      ),
    ).rejects.toThrow(/passwd_app[\s\S]*MIGRATION_DATABASE_URL/);
  });
});
