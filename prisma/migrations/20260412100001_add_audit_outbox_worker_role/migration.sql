-- Create the audit outbox worker role (no password — set out-of-band via initdb or scripts)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_outbox_worker') THEN
    CREATE ROLE passwd_outbox_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Grant database access
GRANT CONNECT ON DATABASE passwd_sso TO passwd_outbox_worker;

-- Defense-in-depth: revoke all schema access before explicit grants
REVOKE ALL ON SCHEMA public FROM passwd_outbox_worker;

-- Minimal schema access
GRANT USAGE ON SCHEMA public TO passwd_outbox_worker;

-- Minimum table privileges: claim + deliver + delete SENT/FAILED rows from outbox,
-- insert delivered rows into audit_logs, read tenant for FK validation.
-- No sequence grants: UUID PKs do not require sequences.
GRANT SELECT, UPDATE, DELETE ON TABLE "audit_outbox" TO passwd_outbox_worker;
GRANT INSERT ON TABLE "audit_logs" TO passwd_outbox_worker;
GRANT SELECT ON TABLE "tenants" TO passwd_outbox_worker;
