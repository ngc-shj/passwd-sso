import { describe, it, expect } from "vitest";
import { roleUrlMismatches } from "./role-url-consistency";

const SUPER = "postgresql://passwd_user:s3cret@localhost:5432/passwd_sso_test";

describe("roleUrlMismatches", () => {
  it("accepts role URLs naming the superuser's host, port and database", () => {
    expect(
      roleUrlMismatches(SUPER, {
        app: "postgresql://passwd_app:x@localhost:5432/passwd_sso_test",
        worker: "postgresql://passwd_outbox_worker:y@localhost/passwd_sso_test",
      }),
    ).toEqual([]);
  });

  it("reports a role URL that names another database", () => {
    const found = roleUrlMismatches(SUPER, {
      app: "postgresql://passwd_app:x@localhost:5432/passwd_sso",
      worker: "postgresql://passwd_outbox_worker:y@localhost:5432/passwd_sso_test",
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("app:");
  });

  it("reports a role URL that names another host or port", () => {
    expect(
      roleUrlMismatches(SUPER, { a: "postgresql://u:p@db.internal:5432/passwd_sso_test" }),
    ).toHaveLength(1);
    expect(
      roleUrlMismatches(SUPER, { b: "postgresql://u:p@localhost:5433/passwd_sso_test" }),
    ).toHaveLength(1);
  });

  it("never prints a password", () => {
    const found = roleUrlMismatches(SUPER, { app: "postgresql://passwd_app:hunter2@localhost:5432/other" });
    expect(found.join("\n")).not.toMatch(/hunter2|s3cret/);
  });
});
