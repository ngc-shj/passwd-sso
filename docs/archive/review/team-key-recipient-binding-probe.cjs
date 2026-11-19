// Plan-stage probe for #1076 on a scratch table, run as the table owner.
// Does a BEFORE UPDATE trigger's `SELECT ... FOR UPDATE` on its own row wait
// for a concurrent FOR KEY SHARE holder? A plain UPDATE of a non-key column
// takes FOR NO KEY UPDATE, which KEY SHARE does not block. The waiting state is
// read from pg_stat_activity after a short pause; the integration race cells
// (pg_blocking_pids witnesses) are the authoritative evidence.
const { Client } = require("pg");
const url = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const setup = new Client({ connectionString: url });
  await setup.connect();
  await setup.query(`
    DROP TABLE IF EXISTS probe1076_users;
    CREATE TABLE probe1076_users (id int PRIMARY KEY, k text);
    INSERT INTO probe1076_users VALUES (1, 'P');
    CREATE OR REPLACE FUNCTION probe1076_trg() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.k IS DISTINCT FROM OLD.k THEN
        PERFORM 1 FROM probe1076_users WHERE id = NEW.id FOR UPDATE;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER probe1076 BEFORE UPDATE ON probe1076_users
      FOR EACH ROW EXECUTE FUNCTION probe1076_trg();`);

  for (const [label, ddl, sql] of [
    ["key change, trigger disabled", "ALTER TABLE probe1076_users DISABLE TRIGGER probe1076", "UPDATE probe1076_users SET k = NULL WHERE id = 1"],
    ["key change, trigger upgrades to FOR UPDATE", "ALTER TABLE probe1076_users ENABLE TRIGGER probe1076", "UPDATE probe1076_users SET k = NULL WHERE id = 1"],
  ]) {
    await setup.query(ddl);
    const a = new Client({ connectionString: url });
    const b = new Client({ connectionString: url });
    await a.connect(); await b.connect();
    await a.query("BEGIN");
    await a.query("SELECT 1 FROM probe1076_users WHERE id = 1 FOR KEY SHARE");
    await b.query("BEGIN");
    let done = false;
    const p = b.query(sql).then(() => { done = true; });
    await sleep(500);

    const w = await setup.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE probe1076_users%'");
    console.log(`${label}: ${done ? "proceeded while KEY SHARE held" : `BLOCKED (sessions waiting on a lock: ${w.rows[0].n})`}`);
    await a.query("COMMIT");
    await p;
    await b.query("ROLLBACK");
    await a.end(); await b.end();
  }
  await setup.query("DROP TABLE probe1076_users; DROP FUNCTION probe1076_trg()");
  await setup.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
