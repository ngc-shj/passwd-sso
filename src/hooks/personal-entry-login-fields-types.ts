"use client";

import type { ComponentProps } from "react";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

export type EntryLoginMainFieldsProps = ComponentProps<typeof EntryLoginMainFields>;

export type PersonalEntryLoginFieldTextProps = Pick<
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

export interface UsePersonalEntryLoginFieldsPropsArgs {
  formState: PersonalPasswordFormState;
  generatorSummary: string;
  translations: Pick<PersonalPasswordFormTranslations, "t">;
}
