export const CUSTOM_FIELD_TYPE = {
  TEXT: "text",
  HIDDEN: "hidden",
  URL: "url",
  BOOLEAN: "boolean",
  DATE: "date",
  MONTH_YEAR: "monthYear",
} as const;

export type CustomFieldType =
  (typeof CUSTOM_FIELD_TYPE)[keyof typeof CUSTOM_FIELD_TYPE];

export const CUSTOM_FIELD_TYPE_VALUES = [
  CUSTOM_FIELD_TYPE.TEXT,
  CUSTOM_FIELD_TYPE.HIDDEN,
  CUSTOM_FIELD_TYPE.URL,
  CUSTOM_FIELD_TYPE.BOOLEAN,
  CUSTOM_FIELD_TYPE.DATE,
  CUSTOM_FIELD_TYPE.MONTH_YEAR,
] as const;
