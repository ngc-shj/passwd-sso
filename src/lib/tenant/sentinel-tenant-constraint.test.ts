import { describe, it, expect } from "vitest";
import {
  SENTINEL_TENANT_CONSTRAINTS,
  classifySentinelTenantConstraint,
} from "@/lib/tenant/sentinel-tenant-constraint";

/**
 * The fixtures below reproduce the nesting measured against this repo's own
 * CHECKs on a real database: `meta.driverAdapterError.cause` carrying the
 * SQLSTATE, with the constraint name only in the message text. The ORM path
 * surfaces as P2039 and the raw path as P2010, so both are exercised — a reader
 * keyed on one would miss the other's writes entirely.
 */
function checkViolation(message: string, prismaCode: "P2039" | "P2010" = "P2010"): Error {
  return Object.assign(new Error(`Database error. Code: \`23514\`. Message: \`${message}\``), {
    code: prismaCode,
    meta: {
      driverAdapterError: {
        message,
        cause: { code: "23514", originalCode: "23514", originalMessage: message, message },
      },
    },
  });
}

const violates = (relation: string, constraint: string) =>
  `new row for relation "${relation}" violates check constraint "${constraint}"`;

describe("classifySentinelTenantConstraint", () => {
  it.each([
    ["users", "users_not_system_tenant"],
    ["teams", "teams_not_system_tenant"],
    ["tenant_members", "tenant_members_not_system_tenant"],
  ])("recognises the %s CHECK and reports which one fired", (relation, constraint) => {
    // By VALUE, not merely "it was one of ours": the three fire on three
    // different sign-in paths, and an operator reading the denial needs to know
    // which write was refused.
    expect(classifySentinelTenantConstraint(checkViolation(violates(relation, constraint))))
      .toEqual({ kind: "sentinel", constraint });
  });

  it("recognises the users CHECK through the ORM path's P2039 code as well", () => {
    expect(
      classifySentinelTenantConstraint(
        checkViolation(violates("users", "users_not_system_tenant"), "P2039"),
      ),
    ).toEqual({ kind: "sentinel", constraint: "users_not_system_tenant" });
  });

  it("does NOT claim a different check violation", () => {
    // The allow arm in the direction that matters. A substring test over the
    // message would be satisfied by any error quoting one of our names; an
    // over-broad classifier would file an unrelated 23514 under a
    // sentinel-claim denial and send the operator to `tenant-domain`.
    expect(
      classifySentinelTenantConstraint(
        checkViolation(violates("audit_logs", "audit_logs_outbox_id_actor_type_check")),
      ),
    ).toEqual({ kind: "other" });
  });

  it("reports a check violation whose constraint cannot be read as its own arm", () => {
    // Reachable: a server with a non-English `lc_messages`. It must not read as
    // "some other constraint" — the caller logs this distinctly and lets the
    // denial fall through to `provider_error`, which is the fail-closed
    // direction.
    const localised = Object.assign(new Error("Database error. Code: `23514`."), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          message: "リレーションの新しい行はチェック制約に違反しています",
          cause: { code: "23514", message: "リレーションの新しい行はチェック制約に違反しています" },
        },
      },
    });
    expect(classifySentinelTenantConstraint(localised)).toEqual({ kind: "unnamed_check" });
  });

  it("does not fire on a non-check SQLSTATE that names one of our constraints", () => {
    // The SQLSTATE is checked first and it is not incidental: a 23505 or a
    // 23503 can quote a constraint name too, and only a CHECK means "the
    // sentinel was the target".
    const unique = Object.assign(new Error("boom"), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "users_not_system_tenant"',
          },
        },
      },
    });
    expect(classifySentinelTenantConstraint(unique)).toEqual({ kind: "other" });
  });

  it.each([null, undefined, new Error("connection refused"), "nope"])(
    "classifies %s as other",
    (input) => {
      expect(classifySentinelTenantConstraint(input)).toEqual({ kind: "other" });
    },
  );

  it("names exactly the three sentinel CHECKs", () => {
    // Pins the CHOICE the type cannot. `teams_not_system_tenant` is
    // unfalsifiable from the application — no sign-in path writes a `teams` row
    // — so without this it could be dropped from the set with every other case
    // here still green.
    expect([...SENTINEL_TENANT_CONSTRAINTS].sort()).toEqual([
      "teams_not_system_tenant",
      "tenant_members_not_system_tenant",
      "users_not_system_tenant",
    ]);
  });
});
