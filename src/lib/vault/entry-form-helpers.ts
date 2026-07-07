export interface TagWithId {
  id: string;
}

export interface TagNameColor {
  name: string;
  color: string | null;
}

import { CUSTOM_FIELD_TYPE } from "@/lib/constants";
import type { CustomFieldType } from "@/lib/constants";

export interface CustomFieldLike {
  label: string;
  value: string;
  type?: CustomFieldType;
}

export function extractTagIds(tags: TagWithId[]): string[] {
  return tags.map((tag) => tag.id);
}

export function toTagNameColor(tags: TagNameColor[]): TagNameColor[] {
  return tags.map((tag) => ({
    name: tag.name,
    color: tag.color,
  }));
}

// Keep any field the user touched; drop only untouched rows (the phantom row
// created by "Add field" and never filled). A field is touched when it carries
// a label or a value. Booleans always carry a value ("true"/"false"), so their
// "untouched" state is the default-off, unlabelled toggle — dropped; a labelled
// or turned-on boolean is kept. This prevents silently discarding user input.
export function filterNonEmptyCustomFields<T extends CustomFieldLike>(
  fields: T[]
): T[] {
  return fields.filter((field) =>
    field.type === CUSTOM_FIELD_TYPE.BOOLEAN
      ? field.label.trim() !== "" || field.value === "true"
      : field.label.trim() !== "" || field.value.trim() !== ""
  );
}

export function parseUrlHost(value: string): string | null {
  if (!value) return null;
  try {
    // hostname is "" for schemes without an authority (javascript:, data:,
    // mailto:) — normalize those to null so they never reach urlHost fields.
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

