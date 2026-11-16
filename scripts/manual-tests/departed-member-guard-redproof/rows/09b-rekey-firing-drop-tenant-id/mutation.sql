DROP TRIGGER tenant_members_departure_ends_memberships_upd ON tenant_members;
CREATE CONSTRAINT TRIGGER tenant_members_departure_ends_memberships_upd
  AFTER UPDATE OF deactivated_at, user_id ON "tenant_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.deactivated_at IS NOT NULL
                     AND (NEW.deactivated_at, NEW.tenant_id, NEW.user_id) IS DISTINCT FROM (OLD.deactivated_at, OLD.tenant_id, OLD.user_id))
  EXECUTE FUNCTION public.departed_member_guard();
