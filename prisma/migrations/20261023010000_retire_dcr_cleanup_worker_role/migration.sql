BEGIN;

-- #935. passwd_dcr_cleanup_worker has been unused since the retention GC worker
-- absorbed DCR cleanup, yet it kept LOGIN, CONNECT, schema USAGE, its table
-- grants and EXECUTE on the RLS bypass functions. Retire it in place: no login,
-- no password, nothing beyond what PUBLIC holds, and no role able to act as it.
-- The role itself stays (a DROP needs every database's dependencies cleared and
-- breaks restores of older dumps that name it); scripts/audit-db-grants.mjs
-- lists it in RETIRED_ROLES and fails if any of this is undone.
--
-- RDS: this runs as the master, which is not a superuser. ALTER ROLE therefore
-- carries no SUPERUSER / BYPASSRLS / REPLICATION clause (refused even as a
-- no-op); 20260428170853 created the role with all three off and the audit
-- asserts them. The master holds ADMIN OPTION on the role because it created
-- it, and PostgreSQL 16 records that as an ADMIN-only membership in the role
-- (admin_option, not inherit_option or set_option). That row confers none of
-- the role's privileges, the master cannot revoke a grant recorded under the
-- bootstrap superuser, and it is left alone.

DO $$
DECLARE
  target oid;
  m record;
  d record;
  s record;
BEGIN
  SELECT oid INTO target FROM pg_roles WHERE rolname = 'passwd_dcr_cleanup_worker';
  IF target IS NULL THEN
    RETURN;
  END IF;

  -- REVOKE cannot take away an owner's rights.
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
     WHERE refclassid = 'pg_authid'::regclass AND refobjid = target AND deptype = 'o'
  ) THEN
    RAISE EXCEPTION 'passwd_dcr_cleanup_worker owns objects; reassign them before retiring it';
  END IF;

  ALTER ROLE passwd_dcr_cleanup_worker WITH NOLOGIN NOCREATEDB NOCREATEROLE PASSWORD NULL;

  -- Memberships it holds, and memberships in it that let another role act as
  -- it. GRANTED BY, because PostgreSQL 16 removes only the named grantor's row.
  FOR m IN
    SELECT g.rolname AS granted, mem.rolname AS member, gr.rolname AS grantor
      FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles mem ON mem.oid = am.member
      JOIN pg_roles gr ON gr.oid = am.grantor
     WHERE am.member = target
        OR (am.roleid = target AND (am.inherit_option OR am.set_option))
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', m.granted, m.member, m.grantor);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am
     WHERE am.member = target
        OR (am.roleid = target AND (am.inherit_option OR am.set_option))
  ) THEN
    RAISE EXCEPTION 'passwd_dcr_cleanup_worker still has a membership after the revokes';
  END IF;

  -- Object privileges in every non-system schema, the same set the grant audit
  -- reads. A table-level REVOKE also removes column-level grants.
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg_toast%'
       AND nspname NOT LIKE 'pg_temp%'
  LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM passwd_dcr_cleanup_worker', s.nspname);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM passwd_dcr_cleanup_worker', s.nspname);
    EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA %I FROM passwd_dcr_cleanup_worker', s.nspname);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM passwd_dcr_cleanup_worker', s.nspname);
  END LOOP;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM passwd_dcr_cleanup_worker', current_database());

  -- Default privileges naming it, whoever owns them. A non-superuser may only
  -- alter the defaults of roles it is a member of; say so instead of failing
  -- mid-statement.
  FOR d IN
    SELECT pg_get_userbyid(da.defaclrole) AS owner, n.nspname, da.defaclobjtype AS objtype
      FROM pg_default_acl da
      LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
      CROSS JOIN LATERAL aclexplode(da.defaclacl) x
     WHERE x.grantee = target
  LOOP
    IF NOT pg_has_role(current_user, d.owner, 'MEMBER') THEN
      RAISE EXCEPTION 'default privileges owned by % name passwd_dcr_cleanup_worker; run as a member of % to retire it',
        d.owner, d.owner;
    END IF;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM passwd_dcr_cleanup_worker',
      d.owner,
      CASE WHEN d.nspname IS NULL THEN '' ELSE format('IN SCHEMA %I', d.nspname) END,
      CASE d.objtype
        WHEN 'r' THEN 'TABLES'
        WHEN 'S' THEN 'SEQUENCES'
        WHEN 'f' THEN 'FUNCTIONS'
        WHEN 'T' THEN 'TYPES'
        WHEN 'n' THEN 'SCHEMAS'
      END
    );
  END LOOP;

  -- What the revokes above cannot reach: a grant whose grantor is not the
  -- object's owner (a REVOKE removes the owner's grants only), and object kinds
  -- the loops do not enumerate. Refuse rather than commit a role that still
  -- holds one; the grant audit would fail on it anyway.
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_database db, aclexplode(db.datacl) x
               WHERE db.datname = current_database() AND x.grantee = target
    UNION ALL SELECT 1 FROM pg_default_acl da, aclexplode(da.defaclacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_type t, aclexplode(t.typacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_language l, aclexplode(l.lanacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_largeobject_metadata o, aclexplode(o.lomacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_foreign_data_wrapper w, aclexplode(w.fdwacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_foreign_server f, aclexplode(f.srvacl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_parameter_acl pa, aclexplode(pa.paracl) x WHERE x.grantee = target
    UNION ALL SELECT 1 FROM pg_tablespace ts, aclexplode(ts.spcacl) x WHERE x.grantee = target
    -- pg_user_mappings, not pg_user_mapping: the catalog is superuser-only.
    UNION ALL SELECT 1 FROM pg_user_mappings um WHERE um.umuser = target
  ) THEN
    RAISE EXCEPTION 'passwd_dcr_cleanup_worker still holds a grant or user mapping the retirement could not revoke';
  END IF;
END
$$;

COMMIT;
