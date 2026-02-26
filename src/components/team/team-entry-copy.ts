import type { TeamEntryKind } from "@/components/team/team-password-form-types";

export interface EntryLocaleCopy {
  edit: string;
  create: string;
  titleLabel: string;
  titlePlaceholder: string;
  notesLabel: string;
  notesPlaceholder: string;
  tagsTitle: string;
}

interface BuildOrgEntryCopyArgs {
  isEdit: boolean;
  entryKind: TeamEntryKind;
  copyByKind: Record<TeamEntryKind, EntryLocaleCopy>;
}

export function buildOrgEntryCopy({
  isEdit,
  entryKind,
  copyByKind,
}: BuildOrgEntryCopyArgs) {
  const selected = copyByKind[entryKind];
  return {
    dialogLabel: isEdit ? selected.edit : selected.create,
    titleLabel: selected.titleLabel,
    titlePlaceholder: selected.titlePlaceholder,
    notesLabel: selected.notesLabel,
    notesPlaceholder: selected.notesPlaceholder,
    tagsTitle: selected.tagsTitle,
  };
}
