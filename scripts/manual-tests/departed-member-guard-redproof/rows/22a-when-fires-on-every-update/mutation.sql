DROP TRIGGER tenant_members_departure_ends_memberships_upd ON tenant_members;
CREATE CONSTRAINT TRIGGER tenant_members_departure_ends_memberships_upd
  AFTER UPDATE ON "tenant_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.deactivated_at IS NOT NULL)
  EXECUTE FUNCTION public.departed_member_guard();
