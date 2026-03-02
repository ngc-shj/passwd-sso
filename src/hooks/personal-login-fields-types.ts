"use client";

import type { ComponentProps } from "react";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { PersonalLoginFormState } from "@/hooks/use-personal-login-form-state";

export type EntryLoginMainFieldsProps = ComponentProps<typeof EntryLoginMainFields>;

export type PersonalLoginFieldTextProps = Pick<
  EntryLoginMainFieldsProps,
  | "titleLabel"
  | "titlePlaceholder"
  | "usernameLabel"
  | "usernamePlaceholder"
  | "passwordLabel"
  | "passwordPlaceholder"
  | "closeGeneratorLabel"
  | "openGeneratorLabel"
  | "urlLabel"
  | "notesLabel"
  | "notesPlaceholder"
>;

export interface BuildPersonalLoginFieldsPropsArgs {
  formState: PersonalLoginFormState;
  generatorSummary: string;
  translations: Pick<PersonalPasswordFormTranslations, "t">;
}
