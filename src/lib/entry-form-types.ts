import type { CustomFieldType, TotpAlgorithm } from "@/lib/constants";

export interface EntryCustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

export interface EntryTotp {
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
}

export interface EntryPasswordHistory {
  password: string;
  changedAt: string;
}

export interface EntryTagNameColor {
  name: string;
  color: string | null;
}

