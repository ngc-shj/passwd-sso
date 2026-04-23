"use client";

import type { ComponentProps } from "react";
import { EntryLoginMainFields } from "@/components/passwords/entry/entry-login-main-fields";
import type { useTeamPolicy } from "@/hooks/team/use-team-policy";

export type EntryLoginMainFieldsProps = ComponentProps<typeof EntryLoginMainFields>;

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

export type TeamLoginFieldTextProps = Pick<
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
> & {
  teamPolicy: TeamPolicy;
};
