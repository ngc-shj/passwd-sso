-- SCIM PUT/PATCH now refuse to reactivate a member another tenant owns, and the
-- 409 they answer is deliberately uninformative. Without an action of its own the
-- refusal would leave this tenant's operator — who must act on it — no trail,
-- while directory sync records the same decision.
BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SCIM_USER_REACTIVATION_REFUSED';

COMMIT;
