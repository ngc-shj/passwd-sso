import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgPasswordFormLifecycleSetters } from "@/hooks/use-org-password-form-state";

export interface OrgPasswordFormLifecycleArgs {
  open: OrgPasswordFormProps["open"];
  editData?: OrgPasswordFormProps["editData"];
  onOpenChange: OrgPasswordFormProps["onOpenChange"];
  setters: OrgPasswordFormLifecycleSetters;
}

export function buildOrgPasswordLifecycleArgs({
  open,
  editData,
  onOpenChange,
  setters,
}: OrgPasswordFormLifecycleArgs): OrgPasswordFormLifecycleArgs {
  return {
    open,
    editData: editData ?? null,
    onOpenChange,
    setters,
  };
}
