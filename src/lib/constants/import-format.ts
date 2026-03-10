/** Import file formats accepted by the import audit API. */
export const IMPORT_FORMAT_VALUES = ["csv", "json", "xml"] as const;
export type ImportFormat = (typeof IMPORT_FORMAT_VALUES)[number];
