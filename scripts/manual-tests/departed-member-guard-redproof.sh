#!/usr/bin/env bash
# departed-member-guard-redproof.sh — the VE4 red-proof runner for the
# departed-member guard (migration 20261117000000_departed_member_guard;
# docs/archive/review/departed-member-db-invariants-plan.md C7 "Red-proofs").
#
# A manual tool, not CI. Each row under departed-member-guard-redproof/rows/ is
# one mutation. For each row the runner:
#
#   1. asserts the template database has no other connection;
#   2. CREATE DATABASE <unique> TEMPLATE <template> as the superuser, then
#      copies the template's database ACL onto it (CREATE DATABASE does not);
#   3. exports DATABASE_URL, MIGRATION_DATABASE_URL and every *_DATABASE_URL
#      the integration harness reads (setup.ts / helpers.ts), all pointed at
#      the scratch database;
#   4. applies the row's setup.sql, if any;
#   5. runs the row's test files unmutated and requires them green, with every
#      expected cell present and passing (a cell that is already red, or a name
#      that matches nothing, pins nothing);
#   6. applies ONE mutation:
#        function.patch  a patch to departed_member_guard() as the migration
#                        defines it, applied with CREATE OR REPLACE;
#        mutation.sql    SQL run as the superuser (a trigger recreated or
#                        renamed, the index dropped);
#        source.patch    a patch to a scratch copy of the tree (source mode);
#   7. runs the same test files with the JSON reporter and records the exit
#      code and the failing cells, compared by full name against `expected`;
#   8. drops the scratch database and the tree copy in a trap.
#
# Never mutates the template database or the working tree: SQL mutations run
# on the scratch database only, and source mutations on a copy made with rsync
# (node_modules symlinked, nothing written through it).
#
# Row files (rows/<NN-slug>/):
#   function.patch | mutation.sql | source.patch   exactly one
#   expected   one cell per line: "<arm token or ->\t<full cell name>"; a line
#              starting "~" is a caveat cell the plan names but that the
#              mutation cannot redden (reported, not judged); a line starting
#              "+" is a collateral cell the mutation may also redden (allowed,
#              not required)
#   tests      optional; lines "<integration|unit> <path>"; default the C7 file
#   setup.sql  optional; superuser SQL applied before the unmutated run
#   add/       optional; files copied into the tree copy (forces source mode)
#   note       optional; one line printed with the result
#
# Usage:
#   scripts/manual-tests/departed-member-guard-redproof.sh [row ...]
#     (default: every row). Results: $REDPROOF_OUT (default a mktemp dir),
#     summary.tsv plus per-row JSON reports and logs.
# Environment: .env's MIGRATION_DATABASE_URL names the superuser and the
# template database (override the template with REDPROOF_TEMPLATE_DB). The
# integration suite must not share the template with a running worker; the
# template must have no connection at all, which step 1 asserts.
# Exit: 0 when every row proved, 1 otherwise.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$ROOT/scripts/manual-tests/departed-member-guard-redproof"
DEFAULT_TEST="src/__tests__/db-integration/departed-member-db-invariants.integration.test.ts"
MIGRATION="$ROOT/prisma/migrations/20261117000000_departed_member_guard/migration.sql"
OUT="${REDPROOF_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/dmg-redproof.XXXXXX")}"
mkdir -p "$OUT"
cd "$ROOT"

# The role URLs, all on one database: node reads .env as the harness does
# (dotenv, no override) and derives the unset ones the way helpers.ts does.
role_urls() {
  local db="$1"
  node -e '
    require("dotenv").config({ path: ".env", quiet: true });
    const db = process.argv[1];
    const base = process.env.DATABASE_URL;
    if (!base || !process.env.MIGRATION_DATABASE_URL) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL must be set in .env");
    const derive = (cred) => base.replace(/\/\/[^:]+:[^@]+@/, `//${cred}@`);
    const urls = {
      DATABASE_URL: base,
      MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
      APP_DATABASE_URL: process.env.APP_DATABASE_URL ?? derive("passwd_app:passwd_app_pass"),
      OUTBOX_WORKER_DATABASE_URL: process.env.OUTBOX_WORKER_DATABASE_URL ?? derive("passwd_outbox_worker:passwd_outbox_pass"),
      RETENTION_GC_DATABASE_URL: process.env.RETENTION_GC_DATABASE_URL ?? derive("passwd_retention_gc_worker:passwd_retention_gc_pass"),
      AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: process.env.AUDIT_ANCHOR_PUBLISHER_DATABASE_URL ?? derive("passwd_anchor_publisher:passwd_anchor_publisher_pass"),
      AUDIT_CHAIN_VERIFY_DATABASE_URL: process.env.AUDIT_CHAIN_VERIFY_DATABASE_URL ?? derive("passwd_audit_chain_verifier:passwd_audit_chain_verifier_pass"),
    };
    for (const [k, v] of Object.entries(urls)) {
      const u = new URL(v);
      if (db) u.pathname = "/" + db;
      process.stdout.write(`${k}=${u.toString()}\n`);
    }
  ' "$db"
}

SUPER_URL="$(role_urls "" | sed -n 's/^MIGRATION_DATABASE_URL=//p')"
TEMPLATE="${REDPROOF_TEMPLATE_DB:-$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$SUPER_URL")}"

# pg_exec <database> <sql-file|-c sql> [param...]: run SQL as the superuser
# through node-postgres (no psql needed); prints rows of the last statement.
pg_exec() {
  local db="$1"; shift
  node -e '
    const { Client } = require("pg");
    const fs = require("fs");
    const [url, db, ...args] = process.argv.slice(1);
    const u = new URL(url); u.pathname = "/" + db;
    const sql = args[0] === "-c" ? args[1] : fs.readFileSync(args[0], "utf8");
    const params = args.slice(args[0] === "-c" ? 2 : 1);
    const c = new Client({ connectionString: u.toString(), application_name: "dmg-redproof" });
    (async () => {
      await c.connect();
      try {
        const r = await c.query(params.length ? { text: sql, values: params } : sql);
        const last = Array.isArray(r) ? r[r.length - 1] : r;
        for (const row of last.rows ?? []) console.log(Object.values(row).join("\t"));
      } finally { await c.end(); }
    })().catch((e) => { console.error(`pg_exec(${db}): ${e.message}`); process.exit(1); });
  ' "$SUPER_URL" "$db" "$@"
}

# The guard function as the migration defines it.
extract_function() {
  awk '/^CREATE OR REPLACE FUNCTION public.departed_member_guard\(\)/ { on = 1 } on { print } on && /^\$\$;$/ { exit }' "$MIGRATION"
}

SCRATCH_DB=""
TREE=""
cleanup() {
  if [[ -n "$SCRATCH_DB" ]]; then
    pg_exec postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null || echo "WARN: could not drop $SCRATCH_DB" >&2
    SCRATCH_DB=""
  fi
  if [[ -n "$TREE" && -d "$TREE" ]]; then
    rm -rf -- "$TREE"
    TREE=""
  fi
}
# INT/TERM exit, so cleanup runs once through EXIT and no further row starts.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

create_scratch() {
  local name="$1"
  local others
  others="$(pg_exec postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = \$1 AND pid <> pg_backend_pid()" "$TEMPLATE")"
  if [[ "$others" != "0" ]]; then
    echo "template $TEMPLATE has $others other connection(s); stop them first" >&2
    return 1
  fi
  SCRATCH_DB="$name"
  pg_exec postgres -c "CREATE DATABASE \"$name\" TEMPLATE \"$TEMPLATE\"" >/dev/null
  # CREATE DATABASE does not copy the database ACL: replicate it, PUBLIC included.
  pg_exec postgres -c "
    DO \$do\$
    DECLARE r record;
    BEGIN
      EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', '$name');
      FOR r IN SELECT a.grantee, a.privilege_type FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = '$TEMPLATE' LOOP
        EXECUTE format('GRANT %s ON DATABASE %I TO %s', r.privilege_type, '$name',
          CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END);
      END LOOP;
    END
    \$do\$" >/dev/null
  local diff
  diff="$(pg_exec postgres -c "
    WITH a AS (SELECT d.datname, x.grantee, x.privilege_type, x.is_grantable FROM pg_database d, aclexplode(d.datacl) x WHERE d.datname IN (\$1, \$2))
    SELECT count(*) FROM (
      (SELECT grantee, privilege_type, is_grantable FROM a WHERE datname = \$1 EXCEPT SELECT grantee, privilege_type, is_grantable FROM a WHERE datname = \$2)
      UNION ALL
      (SELECT grantee, privilege_type, is_grantable FROM a WHERE datname = \$2 EXCEPT SELECT grantee, privilege_type, is_grantable FROM a WHERE datname = \$1)) d" "$TEMPLATE" "$name")"
  if [[ "$diff" != "0" ]]; then
    echo "database ACL of $name differs from $TEMPLATE" >&2
    return 1
  fi
}

# run_tests <workdir> <tests-file|-> <json-out> <log>: one vitest run per config.
run_tests() {
  local dir="$1" spec="$2" json="$3" log="$4"
  local kinds=() ec=0 kind path
  declare -A files=()
  if [[ "$spec" == "-" ]]; then
    files[integration]="$DEFAULT_TEST"
  else
    while read -r kind path; do
      [[ -z "${kind:-}" || "$kind" == \#* ]] && continue
      files[$kind]="${files[$kind]:-} $path"
    done <"$spec"
  fi
  : >"$log"
  local parts=()
  for kind in "${!files[@]}"; do
    local config
    case "$kind" in
      integration) config="vitest.integration.config.ts" ;;
      unit) config="vitest.config.ts" ;;
      *) echo "unknown test kind '$kind'" >&2; return 2 ;;
    esac
    local part="$json.$kind"
    # shellcheck disable=SC2086
    (cd "$dir" && npx vitest run --config "$config" --no-fsModuleCache ${files[$kind]} \
      --reporter=json --outputFile="$part") >>"$log" 2>&1 || ec=$?
    parts+=("$part")
  done
  # Merge: { exitCode, results: [{ name, status, message }] }.
  node -e '
    const fs = require("fs");
    const [out, ec, ...parts] = process.argv.slice(1);
    const results = [];
    let files = 0;
    for (const p of parts) {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const f of j.testResults) {
        files++;
        if (f.status === "failed" && f.assertionResults.length === 0) {
          results.push({ name: `<file failed to load: ${f.name}>`, status: "failed", message: f.message ?? "" });
        }
        for (const a of f.assertionResults) {
          results.push({ name: a.fullName, status: a.status, message: (a.failureMessages ?? []).join("\n") });
        }
      }
    }
    fs.writeFileSync(out, JSON.stringify({ exitCode: Number(ec), files, results }, null, 1));
  ' "$json" "$ec" "${parts[@]}"
  return 0
}

# judge <phase> <json> <expected>: prints a verdict line; exit status 0 = ok.
judge() {
  node -e '
    const fs = require("fs");
    const [phase, json, expectedFile] = process.argv.slice(1);
    const run = JSON.parse(fs.readFileSync(json, "utf8"));
    const exp = fs.readFileSync(expectedFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => { const kind = l[0] === "~" ? "caveat" : l[0] === "+" ? "collateral" : "required";
        const [token, ...rest] = (kind === "required" ? l : l.slice(1)).split("\t"); return { kind, token, name: rest.join("\t") }; });
    const byName = new Map();
    for (const r of run.results) byName.set(r.name, r);
    const failed = run.results.filter((r) => r.status === "failed");
    const missing = exp.filter((e) => e.kind !== "collateral" && !byName.has(e.name)).map((e) => e.name);
    if (phase === "base") {
      const ok = run.exitCode === 0 && run.results.length > 0 && failed.length === 0 && missing.length === 0
        && exp.filter((e) => e.kind !== "collateral").every((e) => byName.get(e.name)?.status === "passed");
      console.log(JSON.stringify({ phase, ok, exitCode: run.exitCode, tests: run.results.length,
        failed: failed.map((f) => f.name), missingExpected: missing }));
      process.exit(ok ? 0 : 1);
    }
    const judged = exp.filter((e) => e.kind === "required");
    const notRed = judged.filter((e) => byName.get(e.name)?.status !== "failed").map((e) => e.name);
    const expectedNames = new Set(exp.map((e) => e.name));
    const extra = failed.filter((f) => !expectedNames.has(f.name)).map((f) => f.name);
    const token = judged.filter((e) => e.token !== "-" && byName.get(e.name)?.status === "failed")
      .map((e) => ({ name: e.name, token: e.token, inMessage: byName.get(e.name).message.includes(e.token) }));
    const caveats = exp.filter((e) => e.kind === "caveat").map((e) => ({ name: e.name, status: byName.get(e.name)?.status ?? "missing" }));
    // Proved only when every required cell is red at its pinned assertion (the
    // failure names its arm token; a deny cell also prints actual=<outcome>),
    // and nothing outside the cells the row lists went red: a broken fixture
    // or a dropped connection reddens cells nobody listed.
    const ok = run.exitCode !== 0 && notRed.length === 0 && missing.length === 0
      && extra.length === 0 && token.every((t) => t.inMessage);
    console.log(JSON.stringify({ phase, ok, exitCode: run.exitCode, tests: run.results.length,
      expectedRed: judged.length, red: failed.length, notRed, missingExpected: missing, extraRed: extra,
      tokenInMessage: token, caveats }));
    process.exit(ok ? 0 : 1);
  ' "$@"
}

run_row() {
  local row="$1" dir="$DATA/rows/$1"
  [[ -d "$dir" ]] || { echo "no row $row" >&2; return 1; }
  local tests="-"; [[ -f "$dir/tests" ]] && tests="$dir/tests"
  local workdir="$ROOT" source_mode=0
  [[ -f "$dir/source.patch" || -d "$dir/add" ]] && source_mode=1
  local n=0
  for f in function.patch mutation.sql source.patch; do [[ -f "$dir/$f" ]] && n=$((n + 1)); done
  [[ "$n" == "1" ]] || { echo "row $row: exactly one of function.patch, mutation.sql, source.patch" >&2; return 1; }

  local db
  db="rp_dmg_$(printf '%s' "$row" | tr -c 'a-z0-9' '_' | cut -c1-30)_$$_$RANDOM"
  echo "== $row (scratch database $db)"
  create_scratch "$db" || { cleanup; return 1; }
  local line
  while IFS='=' read -r k v; do export "$k=$v"; done < <(role_urls "$db")

  if [[ "$source_mode" == "1" ]]; then
    TREE="$(mktemp -d "${TMPDIR:-/tmp}/dmg-redproof-tree.XXXXXX")"
    rsync -a --exclude node_modules --exclude .next --exclude .git --exclude ios --exclude extension \
      --exclude cli --exclude e2e --exclude load-test --exclude infra "$ROOT/" "$TREE/"
    ln -s "$ROOT/node_modules" "$TREE/node_modules"
    [[ -d "$dir/add" ]] && cp -R "$dir/add/." "$TREE/"
    workdir="$TREE"
  fi
  if [[ -f "$dir/setup.sql" ]]; then
    pg_exec "$db" "$dir/setup.sql" >/dev/null || { cleanup; return 1; }
  fi

  local rowout="$OUT/$row"; mkdir -p "$rowout"
  run_tests "$workdir" "$tests" "$rowout/base.json" "$rowout/base.log"
  local base_verdict
  if ! base_verdict="$(judge base "$rowout/base.json" "$dir/expected")"; then
    echo "$base_verdict"
    printf '%s\tBASE-NOT-GREEN\t%s\n' "$row" "$base_verdict" >>"$OUT/summary.tsv"
    cleanup
    return 1
  fi

  if [[ -f "$dir/function.patch" ]]; then
    local fn="$rowout/function.sql"
    extract_function >"$rowout/function.orig.sql"
    patch --quiet --fuzz=0 --no-backup-if-mismatch -o "$fn" "$rowout/function.orig.sql" <"$dir/function.patch" \
      && pg_exec "$db" "$fn" >/dev/null || { echo "row $row: mutation did not apply" >&2; cleanup; return 1; }
  elif [[ -f "$dir/mutation.sql" ]]; then
    pg_exec "$db" "$dir/mutation.sql" >/dev/null || { echo "row $row: mutation did not apply" >&2; cleanup; return 1; }
  else
    patch --quiet --fuzz=0 --no-backup-if-mismatch -p1 -d "$TREE" <"$dir/source.patch" \
      || { echo "row $row: mutation did not apply" >&2; cleanup; return 1; }
  fi

  run_tests "$workdir" "$tests" "$rowout/mutated.json" "$rowout/mutated.log"
  local verdict status=PROVED
  verdict="$(judge mutated "$rowout/mutated.json" "$dir/expected")" || status=FAILED
  echo "$status $verdict"
  [[ -f "$dir/note" ]] && echo "note: $(cat "$dir/note")"
  printf '%s\t%s\t%s\n' "$row" "$status" "$verdict" >>"$OUT/summary.tsv"
  cleanup
  [[ "$status" == "PROVED" ]]
}

rows=("$@")
if [[ ${#rows[@]} -eq 0 ]]; then
  mapfile -t rows < <(ls "$DATA/rows")
fi
echo "template $TEMPLATE; results in $OUT"
rc=0
for r in "${rows[@]}"; do
  run_row "$r" || rc=1
done
echo "summary: $OUT/summary.tsv"
exit "$rc"
