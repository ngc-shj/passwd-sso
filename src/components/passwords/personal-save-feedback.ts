import { toast } from "sonner";

interface RouterLike {
  push: (href: string) => void;
  refresh: () => void;
}

interface PersonalSaveFeedbackParams {
  res: Response;
  mode: "create" | "edit";
  t: (key: "saved" | "updated" | "failedToSave") => string;
  router: RouterLike;
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
