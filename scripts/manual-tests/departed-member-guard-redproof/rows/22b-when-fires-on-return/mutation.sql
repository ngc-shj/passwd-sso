DROP TRIGGER tenant_members_departure_ends_memberships_upd ON tenant_members;
CREATE CONSTRAINT TRIGGER tenant_members_departure_ends_memberships_upd
  AFTER UPDATE OF deactivated_at ON "tenant_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at)
  EXECUTE FUNCTION public.departed_member_guard();
