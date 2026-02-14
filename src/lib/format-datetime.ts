export function formatDateTime(value: string | Date, locale: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(locale);
}

export function formatDate(value: string | Date, locale: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString(locale);
}
