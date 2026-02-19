import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormControllerArgs } from "@/hooks/personal-password-form-controller-args";

export type PersonalPasswordFormDerivedArgs = Pick<
  PersonalPasswordFormControllerArgs,
  "initialData" | "values" | "translations"
>;
