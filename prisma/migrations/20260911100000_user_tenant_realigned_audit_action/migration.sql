-- The sign-in path that joins a user to a tenant they hold no data in now
-- realigns User.tenantId onto that membership and reports what it left behind.
-- Without an action of its own the realignment would be indistinguishable from
-- an ordinary join, and the stranded rows would be reported by nothing.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_TENANT_REALIGNED';

COMMIT;
