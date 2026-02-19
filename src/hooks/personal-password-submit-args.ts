import type { SubmitPersonalPasswordFormArgs } from "@/components/passwords/personal-password-submit";
import type { PersonalPasswordFormControllerArgs } from "@/hooks/personal-password-form-controller-args";

type PersonalPasswordSubmitBuilderArgs = Pick<
  PersonalPasswordFormControllerArgs,
  | "mode"
  | "initialData"
  | "encryptionKey"
  | "userId"
  | "values"
  | "setSubmitting"
  | "translations"
  | "onSaved"
> & {
  router: Pick<PersonalPasswordFormControllerArgs["router"], "push" | "refresh">;
};

export function buildPersonalPasswordSubmitArgs({
  mode,
  initialData,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
  onSaved,
}: PersonalPasswordSubmitBuilderArgs): SubmitPersonalPasswordFormArgs {
  const { t } = translations;
  return {
    mode,
    initialData,
    encryptionKey,
    userId: userId ?? undefined,
    title: values.title,
    username: values.username,
    password: values.password,
    url: values.url,
    notes: values.notes,
    selectedTags: values.selectedTags,
    generatorSettings: values.generatorSettings,
    customFields: values.customFields,
    totp: values.totp,
    requireReprompt: values.requireReprompt,
    folderId: values.folderId,
    setSubmitting,
    t,
    router,
    onSaved,
  };
}
