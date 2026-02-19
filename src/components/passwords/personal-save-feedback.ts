import { toast } from "sonner";
import type { PasswordSubmitRouter } from "@/hooks/password-form-router";

interface PersonalSaveFeedbackParams {
  res: Response;
  mode: "create" | "edit";
  t: (key: "saved" | "updated" | "failedToSave") => string;
  router: PasswordSubmitRouter;
  onSaved?: () => void;
}

export function handlePersonalSaveFeedback({
  res,
  mode,
  t,
  router,
  onSaved,
}: PersonalSaveFeedbackParams): void {
  if (!res.ok) {
    toast.error(t("failedToSave"));
    return;
  }

  toast.success(mode === "create" ? t("saved") : t("updated"));
  if (onSaved) {
    onSaved();
    return;
  }
  router.push("/dashboard");
  router.refresh();
}
