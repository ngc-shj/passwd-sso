"use client";

import { toast } from "sonner";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";

interface ApiErrorShape {
  error?: unknown;
}

export async function showSidebarCrudError(
  res: Response,
  tErrors: (key: string) => string,
): Promise<void> {
  try {
    const json = (await res.json()) as ApiErrorShape;
    const i18nKey = apiErrorToI18nKey(json.error);
    toast.error(tErrors(i18nKey));
  } catch {
    toast.error(tErrors("unknownError"));
  }
}
