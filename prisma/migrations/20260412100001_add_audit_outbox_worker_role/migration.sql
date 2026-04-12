-- Create the audit outbox worker role (no password — set out-of-band via initdb or scripts)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_outbox_worker') THEN
    CREATE ROLE passwd_outbox_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Grant database access (use current_database() to avoid hardcoding DB name)
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_outbox_worker', current_database());
END $$;

-- Defense-in-depth: revoke all schema access before explicit grants
REVOKE ALL ON SCHEMA public FROM passwd_outbox_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_outbox_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_outbox_worker;

-- Minimal schema access
GRANT USAGE ON SCHEMA public TO passwd_outbox_worker;

-- Minimum table privileges: claim + deliver + delete SENT/FAILED rows from outbox,
-- insert delivered rows into audit_logs, read tenant for FK validation.
-- No sequence grants: UUID PKs do not require sequences.
GRANT SELECT, UPDATE, DELETE ON TABLE "audit_outbox" TO passwd_outbox_worker;
-- SELECT needed for ON CONFLICT (outbox_id) DO NOTHING dedup check
GRANT SELECT, INSERT ON TABLE "audit_logs" TO passwd_outbox_worker;
-- FK-referenced tables: SELECT needed for referential integrity checks under RLS
GRANT SELECT ON TABLE "tenants" TO passwd_outbox_worker;
GRANT SELECT ON TABLE "users" TO passwd_outbox_worker;
GRANT SELECT ON TABLE "teams" TO passwd_outbox_worker;
GRANT SELECT ON TABLE "service_accounts" TO passwd_outbox_worker;
