/** Export file formats accepted by the export audit API. */
export const EXPORT_FORMAT_VALUES = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
