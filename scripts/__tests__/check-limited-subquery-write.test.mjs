/**
 * Table-driven self-test for check-limited-subquery-write.mjs (plan:
 * worker-batch-limit-overrun, C2). Each row runs the real CLI against an
 * isolated fixture tree (mkdtemp + LIMITED_SUBQUERY_WRITE_CHECK_ROOT), never
 * the tracked repo files.
 *
 * Deny rows: every member M1–M15 exactly as it was before the fix, every
 * overrunning form from the plan's probe and review log, and the shapes the
 * rule refuses by class. Allow rows: each C1 shape, the nearest non-writes,
 * and one row per declared bypass (pinning the blind spot, not endorsing it).
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-limited-subquery-write.mjs", import.meta.url));

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

// Every fixture tree holds one clean file, so a row whose subject is skipped
// still analyses >0 files and cannot pass through ZERO_FILES_SCANNED.
const BASELINE = { "src/clean.ts": "export const clean = 1;\n" };

function run(files, { baseline = true, prepare } = {}) {
  const root = mkdtempSync(join(tmpdir(), "limited-subquery-write-"));
  dirs.push(root);
  writeFiles(root, baseline ? { ...BASELINE, ...files } : files);
  if (prepare) prepare(root);
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: { ...process.env, LIMITED_SUBQUERY_WRITE_CHECK_ROOT: root },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

// A template literal argument, as the workers pass SQL. `sql` is spliced in
// verbatim, so a `${…}` in it is a real substitution in the fixture.
const unsafeCall = (sql) =>
  `export async function run(tx: any, a: unknown, b: unknown) {\n  return tx.$queryRawUnsafe(\`${sql}\`, a, b);\n}\n`;
// A double-quoted string literal argument.
const stringCall = (sql) =>
  `export async function run(tx: any) {\n  return tx.$executeRawUnsafe(${JSON.stringify(sql)}, 1);\n}\n`;
// A tagged template wrapped in a call, as M11–M14 build SQL. The tag and the
// wrapper are named neutrally: the gate never consults either.
const taggedCall = (sql) =>
  "declare const frag: (s: TemplateStringsArray, ...v: unknown[]) => string;\n" +
  "declare const render: (s: string) => string;\n" +
  "declare const tableIdent: string, keyList: string, cutoffIdent: string, predicateSql: string, guardSql: string, cutoffSql: string, projection: string;\n" +
  `export async function run(tx: any) {\n  return tx.$executeRawUnsafe(render(frag\`${sql}\`), 1);\n}\n`;

// ---------------------------------------------------------------------------
// Pre-fix member shapes (M1–M15), copied from the code before C1.
// ---------------------------------------------------------------------------
const PRE_FIX = {
  M1: unsafeCall(`
      UPDATE audit_outbox
      SET status = 'PROCESSING',
          processing_started_at = now()
      WHERE id IN (
        SELECT id FROM audit_outbox
        WHERE status = 'PENDING'
          AND next_retry_at <= now()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      AND status = 'PENDING'
      RETURNING *
    `),
  M2: unsafeCall(`UPDATE "audit_deliveries"
       SET "status" = 'PROCESSING',
           "processing_started_at" = now()
       WHERE "id" IN (
         SELECT "id" FROM "audit_deliveries"
         WHERE "status" = 'PENDING'
           AND "next_retry_at" <= now()
         ORDER BY "created_at" ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       AND "status" = 'PENDING'
       RETURNING "id"`),
  M3: unsafeCall(`UPDATE webhook_deliveries
       SET status = 'PROCESSING',
           processing_started_at = now()
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'PENDING'
           AND next_retry_at <= now()
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       AND status = 'PENDING'
       RETURNING id, outbox_id, tenant_id, scope::text AS scope,
                 team_id, action, attempt_count, max_attempts`),
  M4: unsafeCall(`UPDATE audit_outbox
     SET status = CASE
           WHEN attempt_count + 1 >= max_attempts THEN 'FAILED'::"AuditOutboxStatus"
           ELSE 'PENDING'::"AuditOutboxStatus"
         END,
         processing_started_at = NULL,
         attempt_count = attempt_count + 1,
         last_error = LEFT('[reaped after timeout, attempt ' || (attempt_count + 1)::text || ']', 1024)
     WHERE id IN (
       SELECT id FROM audit_outbox
       WHERE status = 'PROCESSING'
         AND processing_started_at < now() - make_interval(secs => $1)
       ORDER BY processing_started_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, tenant_id, attempt_count, status::text AS new_status`),
  M5: unsafeCall(`UPDATE "audit_deliveries"
     SET "status" = CASE
       WHEN "attempt_count" + 1 >= "max_attempts" THEN 'FAILED'::"AuditDeliveryStatus"
       ELSE 'PENDING'::"AuditDeliveryStatus"
     END,
     "attempt_count" = "attempt_count" + 1,
     "processing_started_at" = NULL,
     "last_error" = 'reaped: processing timeout exceeded'
     WHERE "id" IN (
       SELECT "id" FROM "audit_deliveries"
       WHERE "status" = 'PROCESSING'
         AND "processing_started_at" < $1
       ORDER BY "processing_started_at" ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING "id", "tenant_id", "attempt_count", "status"::text AS new_status`),
  M6: unsafeCall(`UPDATE webhook_deliveries
       SET status = CASE
         WHEN attempt_count + 1 >= max_attempts THEN 'FAILED'::"AuditDeliveryStatus"
         ELSE 'PENDING'::"AuditDeliveryStatus"
       END,
       attempt_count = attempt_count + 1,
       processing_started_at = NULL,
       last_error = 'reaped: processing timeout exceeded'
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'PROCESSING'
           AND processing_started_at < $1
         ORDER BY processing_started_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, scope::text AS scope, team_id, action,
                 attempt_count, status::text AS new_status`),
  M7: unsafeCall(`DELETE FROM "audit_deliveries"
       WHERE "id" IN (
         SELECT "id" FROM "audit_deliveries"
         WHERE ("status" = 'SENT' AND "created_at" < $1)
            OR ("status" = 'FAILED' AND "created_at" < $2)
         ORDER BY "created_at" ASC
         LIMIT $3
       )`),
  M8: unsafeCall(`DELETE FROM webhook_deliveries
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE (status = 'SENT' AND created_at < $1)
            OR (status = 'FAILED' AND created_at < $2)
         ORDER BY created_at ASC
         LIMIT $3
       )`),
  M9: unsafeCall(`WITH deleted AS (
      DELETE FROM audit_outbox
      WHERE id IN (
        SELECT id FROM audit_outbox
        WHERE status = 'SENT'
          AND sent_at < now() - make_interval(hours => $1)
          AND NOT EXISTS (
            SELECT 1 FROM "audit_deliveries"
            WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
              AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "webhook_deliveries"
            WHERE "webhook_deliveries"."outbox_id" = "audit_outbox"."id"
              AND "webhook_deliveries"."status" IN ('PENDING', 'PROCESSING')
          )
        ORDER BY sent_at ASC
        LIMIT $2
      )
      RETURNING id, tenant_id
    )
    SELECT tenant_id::text AS tenant_id, COUNT(*) AS purged FROM deleted GROUP BY tenant_id`),
  M10: unsafeCall(`WITH deleted AS (
      DELETE FROM audit_outbox
      WHERE id IN (
        SELECT id FROM audit_outbox
        WHERE status = 'FAILED'
          AND created_at < now() - make_interval(days => $1)
        ORDER BY created_at ASC
        LIMIT $2
      )
      RETURNING id, tenant_id
    )
    SELECT tenant_id::text AS tenant_id, COUNT(*) AS purged FROM deleted GROUP BY tenant_id`),
  M11: taggedCall(`DELETE FROM \${tableIdent}
    WHERE (\${keyList}) IN (
      SELECT \${keyList} FROM \${tableIdent}
      WHERE \${cutoffIdent} < now()\${predicateSql}
      LIMIT $1
    )`),
  M12: taggedCall(`DELETE FROM \${tableIdent}
    WHERE (\${keyList}) IN (
      SELECT \${keyList} FROM \${tableIdent}
      WHERE \${cutoffIdent} < now()
      \${guardSql}
      LIMIT $1
    )`),
  M13: taggedCall(`DELETE FROM \${tableIdent}
       WHERE (id) IN (
         SELECT id FROM \${tableIdent}
         WHERE \${cutoffSql}\${guardSql}
         LIMIT $1
       )
       RETURNING \${projection}`),
  M14: taggedCall(`DELETE FROM \${tableIdent}
         WHERE (id) IN (
           SELECT id FROM \${tableIdent}
           WHERE tenant_id = $1::uuid
             AND \${cutoffIdent} < $2::timestamptz
           LIMIT $3
         )`),
  M15: unsafeCall(`UPDATE access_requests
       SET status = 'EXPIRED'
       WHERE (id) IN (
         SELECT id FROM access_requests
         WHERE status = 'PENDING' AND expires_at < now()
         LIMIT $1
       )
       AND status = 'PENDING'`),
};

// The same members in the C1 shape: the subquery moves, unchanged, into a
// MATERIALIZED CTE and the write reads its keys from it.
const C1 = {
  M1: unsafeCall(`
      WITH picked AS MATERIALIZED (
        SELECT id FROM audit_outbox
        WHERE status = 'PENDING'
          AND next_retry_at <= now()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE audit_outbox
      SET status = 'PROCESSING',
          processing_started_at = now()
      WHERE id IN (SELECT id FROM picked)
      AND status = 'PENDING'
      RETURNING *
    `),
  M2: unsafeCall(`WITH picked AS MATERIALIZED (
         SELECT "id" FROM "audit_deliveries"
         WHERE "status" = 'PENDING'
           AND "next_retry_at" <= now()
         ORDER BY "created_at" ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE "audit_deliveries"
       SET "status" = 'PROCESSING',
           "processing_started_at" = now()
       WHERE "id" IN (SELECT "id" FROM picked)
       AND "status" = 'PENDING'
       RETURNING "id"`),
  M4: unsafeCall(`WITH picked AS MATERIALIZED (
       SELECT id FROM audit_outbox
       WHERE status = 'PROCESSING'
         AND processing_started_at < now() - make_interval(secs => $1)
       ORDER BY processing_started_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE audit_outbox
     SET status = CASE
           WHEN attempt_count + 1 >= max_attempts THEN 'FAILED'::"AuditOutboxStatus"
           ELSE 'PENDING'::"AuditOutboxStatus"
         END,
         processing_started_at = NULL,
         attempt_count = attempt_count + 1
     WHERE id IN (SELECT id FROM picked)
     RETURNING id, tenant_id, attempt_count, status::text AS new_status`),
  M7: unsafeCall(`WITH picked AS MATERIALIZED (
         SELECT "id" FROM "audit_deliveries"
         WHERE ("status" = 'SENT' AND "created_at" < $1)
            OR ("status" = 'FAILED' AND "created_at" < $2)
         ORDER BY "created_at" ASC
         LIMIT $3
       )
       DELETE FROM "audit_deliveries"
       WHERE "id" IN (SELECT "id" FROM picked)`),
  M9: unsafeCall(`WITH picked AS MATERIALIZED (
        SELECT id FROM audit_outbox
        WHERE status = 'SENT'
          AND sent_at < now() - make_interval(hours => $1)
          AND NOT EXISTS (
            SELECT 1 FROM "audit_deliveries"
            WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
              AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
          )
        ORDER BY sent_at ASC
        LIMIT $2
      ),
      deleted AS (
        DELETE FROM audit_outbox
        WHERE id IN (SELECT id FROM picked)
        RETURNING id, tenant_id
      )
    SELECT tenant_id::text AS tenant_id, COUNT(*) AS purged FROM deleted GROUP BY tenant_id`),
  M11: taggedCall(`WITH picked AS MATERIALIZED (
      SELECT \${keyList} FROM \${tableIdent}
      WHERE \${cutoffIdent} < now()\${predicateSql}
      LIMIT $1
    )
    DELETE FROM \${tableIdent}
    WHERE (\${keyList}) IN (SELECT \${keyList} FROM picked)`),
  M13: taggedCall(`WITH picked AS MATERIALIZED (
         SELECT id FROM \${tableIdent}
         WHERE \${cutoffSql}\${guardSql}
         LIMIT $1
       )
       DELETE FROM \${tableIdent}
       WHERE (id) IN (SELECT id FROM picked)
       RETURNING \${projection}`),
  M15: unsafeCall(`WITH picked AS MATERIALIZED (
         SELECT id FROM access_requests
         WHERE status = 'PENDING' AND expires_at < now()
         LIMIT $1
       )
       UPDATE access_requests
       SET status = 'EXPIRED'
       WHERE (id) IN (SELECT id FROM picked)
       AND status = 'PENDING'`),
};

const SUB = `SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC`;
const SET = "UPDATE audit_outbox SET attempt_count = attempt_count + 1";

function expectDeny(result, line) {
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("LIMITED_SUBQUERY_WRITE");
  expect(result.stderr).toContain("WITH picked AS MATERIALIZED");
  if (line !== undefined) expect(result.stderr).toContain(line);
}
function expectAllow(result) {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("check-limited-subquery-write: OK");
}

describe("deny — every member M1–M15 as written before the fix", () => {
  for (const [member, src] of Object.entries(PRE_FIX)) {
    it(`deny: pre-fix ${member}`, () => {
      expectDeny(run({ "src/workers/fixture.ts": src }), "src/workers/fixture.ts:");
    });
  }

  it("deny: names the LIMIT's own line", () => {
    // M1's LIMIT is line 10 of the literal, which starts on line 2 of the file.
    expectDeny(run({ "src/workers/fixture.ts": PRE_FIX.M1 }), "src/workers/fixture.ts:11 ");
  });
});

describe("deny — the overrunning forms from the probe and review log", () => {
  const rows = [
    ["A: IN (… ORDER BY … LIMIT FOR UPDATE SKIP LOCKED)", `WITH r AS (${SET} WHERE id IN (${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED) RETURNING id) SELECT count(*) FROM r`],
    ["B: IN (… LIMIT FOR UPDATE), no ORDER BY", `${SET} WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PROCESSING' LIMIT 2 FOR UPDATE)`],
    ["C: IN (… ORDER BY … LIMIT), no lock", `${SET} WHERE id IN (${SUB} LIMIT 2)`],
    ["E: = ANY (SELECT … LIMIT …)", `${SET} WHERE id = ANY (${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED)`],
    ["F: = ANY (ARRAY(SELECT … LIMIT …)), uncorrelated", `${SET} WHERE id = ANY (ARRAY(${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED))`],
    ["Q: = ANY (ARRAY(SELECT … LIMIT …)), correlated", `${SET} o WHERE o.id = ANY (ARRAY(SELECT t2.id FROM audit_outbox t2 WHERE t2.tenant_id = o.tenant_id LIMIT 2 FOR UPDATE SKIP LOCKED))`],
    ["N: IN ((SELECT … LIMIT …))", `${SET} WHERE id IN ((${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED))`],
    ["P: IN (WITH q AS (…) SELECT … LIMIT …)", `${SET} WHERE id IN (WITH q AS (${SUB}) SELECT id FROM q LIMIT 2)`],
    ["O: FETCH FIRST n ROWS ONLY", `${SET} WHERE id IN (${SUB} FETCH FIRST 2 ROWS ONLY FOR UPDATE SKIP LOCKED)`],
    ["O': FETCH NEXT n ROWS ONLY", `${SET} WHERE id IN (${SUB} FETCH NEXT 2 ROWS ONLY)`],
    ["T: derived table IN (SELECT id FROM (… LIMIT …) s)", `${SET} WHERE id IN (SELECT id FROM (${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED) s)`],
    ["V1: materialized CTE nested in IN, uncorrelated", `${SET} WHERE id IN (WITH p AS MATERIALIZED (${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED) SELECT id FROM p)`],
    ["V2: materialized CTE nested in IN, correlated", `${SET} o WHERE o.id IN (WITH p AS MATERIALIZED (SELECT id FROM audit_outbox t2 WHERE t2.tenant_id = o.tenant_id LIMIT 2 FOR UPDATE SKIP LOCKED) SELECT id FROM p)`],
    ["V3: materialized CTE nested in ARRAY, correlated", `${SET} o WHERE o.id = ANY (ARRAY(WITH p AS MATERIALIZED (SELECT id FROM audit_outbox t2 WHERE t2.tenant_id = o.tenant_id LIMIT 2 FOR UPDATE) SELECT id FROM p))`],
    ["V4: materialized CTE nested in ARRAY, uncorrelated", `${SET} WHERE id = ANY (ARRAY(WITH p AS MATERIALIZED (${SUB} LIMIT 2) SELECT id FROM p))`],
    ["UPDATE … FROM (… LIMIT …) s", `${SET} FROM (${SUB} LIMIT 2) s WHERE audit_outbox.id = s.id`],
    ["DELETE … USING (… LIMIT …) s", `DELETE FROM audit_outbox USING (${SUB} LIMIT 2) s WHERE audit_outbox.id = s.id`],
    ["non-materialized CTE", `WITH picked AS (${SUB} LIMIT 2) ${SET} WHERE id IN (SELECT id FROM picked)`],
    ["AS NOT MATERIALIZED", `WITH picked AS NOT MATERIALIZED (${SUB} LIMIT 2) ${SET} WHERE id IN (SELECT id FROM picked)`],
    ["LIMIT nested one level inside a materialized body", `WITH picked AS MATERIALIZED (SELECT id FROM (${SUB} LIMIT 2) s) ${SET} WHERE id IN (SELECT id FROM picked)`],
    ["a second LIMIT outside the materialized body", `WITH picked AS MATERIALIZED (${SUB} LIMIT 2) ${SET} WHERE id IN (SELECT id FROM picked) AND tenant_id IN (SELECT id FROM tenants LIMIT 1)`],
    ["lowercase write", `with r as (update audit_outbox set attempt_count = 1 where id in (select id from audit_outbox limit 2 for update skip locked) returning id) select count(*) from r`],
    ["write after ;", `SELECT 1; DELETE FROM audit_outbox WHERE id IN (SELECT id FROM audit_outbox LIMIT 2)`],
  ];
  for (const [name, sql] of rows) {
    it(`deny: ${name}`, () => {
      expectDeny(run({ "src/workers/fixture.ts": stringCall(sql) }));
    });
  }
});

describe("deny/skip/error — the walk (scan roots, extensions, exclusions)", () => {
  const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
  // A plain-JS body: valid in every extension.
  const plainM1 = (sql) => `export const q = ${JSON.stringify(sql)};\n`;
  const M1_SQL = `UPDATE audit_outbox SET status = 'PROCESSING' WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED) AND status = 'PENDING' RETURNING *`;

  for (const ext of EXTS) {
    // One directory below the fixture root's scan root: a walk that dropped
    // the extension set on recursion would miss it.
    it(`deny: pre-fix M1 in a nested ${ext} file`, () => {
      expectDeny(run({ [`src/nested/deep/m1${ext}`]: plainM1(M1_SQL) }), `src/nested/deep/m1${ext}:`);
    });
    it(`skip: pre-fix M1 in a .test${ext} and a .spec${ext} file`, () => {
      expectAllow(run({ [`src/nested/m1.test${ext}`]: plainM1(M1_SQL), [`src/nested/m1.spec${ext}`]: plainM1(M1_SQL) }));
    });
  }

  it("deny: pre-fix M1 under scripts/", () => {
    expectDeny(run({ "scripts/tool.mjs": plainM1(M1_SQL) }), "scripts/tool.mjs:");
  });

  it("deny: pre-fix M1 under prisma/", () => {
    expectDeny(run({ "prisma/seed.ts": plainM1(M1_SQL) }), "prisma/seed.ts:");
  });

  it("skip: pre-fix M1 in a file under __tests__/", () => {
    expectAllow(run({ "src/__tests__/m1.ts": plainM1(M1_SQL), "src/workers/__tests__/deep/m1.mjs": plainM1(M1_SQL) }));
  });

  it("skip: a file outside the scan roots", () => {
    expectAllow(run({ "docs/m1.ts": plainM1(M1_SQL), "e2e/m1.ts": plainM1(M1_SQL) }));
  });

  it("error: a symlink under a scan root fails the gate", () => {
    const result = run(
      { "src/real.ts": "export const r = 1;\n" },
      { prepare: (root) => symlinkSync("./real.ts", join(root, "src", "alias.ts")) },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refusing to decide about a symlink/);
  });

  it("error: zero files analysed fails closed", () => {
    const result = run({ "docs/readme.ts": "export const x = 1;\n" }, { baseline: false });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ZERO_FILES_SCANNED");
  });

  it("error: a file that fails to parse fails closed", () => {
    const result = run({ "src/broken.ts": "export const = ;\n" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PARSE_ERROR");
    expect(result.stderr).toContain("src/broken.ts");
  });
});

describe("allow — the C1 shapes", () => {
  for (const [member, src] of Object.entries(C1)) {
    it(`allow: C1 ${member}`, () => {
      expectAllow(run({ "src/workers/fixture.ts": src }));
    });
  }

  it("allow: probe D (materialized key set, write in a sibling CTE)", () => {
    const sql = `WITH picked AS MATERIALIZED (${SUB} LIMIT 2 FOR UPDATE SKIP LOCKED), r AS (${SET} WHERE id IN (SELECT id FROM picked) RETURNING id) SELECT count(*) FROM r`;
    expectAllow(run({ "src/workers/fixture.ts": stringCall(sql) }));
  });

  it("allow: FETCH FIRST at the top of a materialized body", () => {
    const sql = `WITH picked AS MATERIALIZED (${SUB} FETCH FIRST 2 ROWS ONLY) ${SET} WHERE id IN (SELECT id FROM picked)`;
    expectAllow(run({ "src/workers/fixture.ts": stringCall(sql) }));
  });
});

describe("allow — the nearest non-writes", () => {
  const rows = [
    ["a standalone SELECT … LIMIT", `SELECT id FROM audit_outbox ORDER BY created_at LIMIT $1`],
    ["a SELECT … FOR UPDATE … LIMIT with no write", `SELECT id FROM audit_outbox WHERE status = 'PENDING' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`],
    ["a SELECT … LIMIT … FOR NO KEY UPDATE", `SELECT id FROM audit_outbox LIMIT 1 FOR NO KEY UPDATE`],
    ["IN (SELECT …) without LIMIT", `DELETE FROM audit_outbox WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'FAILED')`],
    ["the old shape inside a SQL -- comment", `UPDATE t SET a = 1 WHERE id = $1 -- was: WHERE id IN (SELECT id FROM t LIMIT 1)`],
    ["the old shape inside a SQL /* */ comment", `DELETE FROM t /* WHERE id IN (SELECT id FROM t LIMIT 1) */ WHERE id = $1`],
    ["the old shape inside a SQL string", `UPDATE t SET note = 'id IN (SELECT id FROM t LIMIT 1)' WHERE id = $1`],
    ["INSERT … SELECT … LIMIT … ON CONFLICT DO UPDATE (no statement-position write)", `INSERT INTO t (id) SELECT id FROM u LIMIT 10 ON CONFLICT (id) DO UPDATE SET a = 1`],
    ["prose that starts with Update and mentions a limit", `Update your profile before the limit is reached`],
    // Grammatical `UPDATE <t> SET`, but mid-sentence: only statement position excludes it.
    ["prose that embeds UPDATE <t> SET mid-sentence and mentions a LIMIT", `Worker failed to UPDATE audit_outbox SET status for a batch over the LIMIT`],
  ];
  for (const [name, sql] of rows) {
    it(`allow: ${name}`, () => {
      expectAllow(run({ "src/workers/fixture.ts": stringCall(sql) }));
    });
  }

  it("allow: the old shape inside a JS comment", () => {
    expectAllow(run({ "src/workers/fixture.ts": `// DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 1)\nexport const x = 1;\n` }));
  });
});

describe("allow — declared bypasses (pinned blind spots)", () => {
  it("bypass: SQL split across literals by concatenation", () => {
    const src =
      `export async function run(tx: any) {\n  return tx.$executeRawUnsafe(\n` +
      `    "DELETE FROM t WHERE id IN (SELECT id FROM t " +\n    "LIMIT $1)",\n    1,\n  );\n}\n`;
    expectAllow(run({ "src/workers/fixture.ts": src }));
  });

  it("bypass: the bounding subquery in a separate interpolated fragment", () => {
    const src =
      "declare const frag: (s: TemplateStringsArray, ...v: unknown[]) => string;\n" +
      "declare const render: (s: string) => string;\n" +
      "const bound = frag`SELECT id FROM t ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`;\n" +
      "export async function run(tx: any) {\n" +
      "  return tx.$executeRawUnsafe(render(frag`DELETE FROM t WHERE id IN (${bound})`), 1);\n}\n";
    expectAllow(run({ "src/workers/fixture.ts": src }));
  });

  it("bypass: SQL in prisma/migrations/*.sql", () => {
    expectAllow(
      run({
        "prisma/migrations/20990101000000_x/migration.sql":
          "DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 1 FOR UPDATE SKIP LOCKED);\n",
      }),
    );
  });

  it("bypass: a plpgsql body (dollar-quoted) in a literal", () => {
    // The DELETE follows a `;` inside the body, so only the dollar quote hides it.
    const sql =
      "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; " +
      "DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 1 FOR UPDATE SKIP LOCKED); END $$";
    expectAllow(run({ "src/workers/fixture.ts": stringCall(sql) }));
  });
});
