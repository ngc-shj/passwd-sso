"use client";

import { EntryTagsAndFolderLayout } from "@/components/passwords/entry-tags-and-folder-layout";
import { TeamTagInput } from "@/components/team/team-tag-input";
import type { TeamFolderItem } from "@/components/team/team-password-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";

interface TeamTagsAndFolderSectionProps {
  tagsTitle: string;
  tagsHint: string;
  teamId?: string;
  orgId?: string;
  selectedTags: TeamTagData[];
  onTagsChange: (tags: TeamTagData[]) => void;
  folders: TeamFolderItem[];
  folderId: string | null;
  onFolderChange: (folderId: string | null) => void;
  sectionCardClass?: string;
}

export type OrgTagsAndFolderSectionProps = TeamTagsAndFolderSectionProps;

export function TeamTagsAndFolderSection({
  tagsTitle,
  tagsHint,
  teamId,
  orgId,
  selectedTags,
  onTagsChange,
  folders,
  folderId,
  onFolderChange,
  sectionCardClass = "",
}: TeamTagsAndFolderSectionProps) {
  const scopedId = teamId ?? orgId;
  if (!scopedId) return null;
  return (
    <EntryTagsAndFolderLayout
      tagsTitle={tagsTitle}
      tagsHint={tagsHint}
      tagsInput={<TeamTagInput teamId={scopedId} selectedTags={selectedTags} onChange={onTagsChange} />}
      folders={folders}
      folderId={folderId}
      onFolderChange={onFolderChange}
      sectionCardClass={sectionCardClass}
    />
  );
}

export const OrgTagsAndFolderSection = TeamTagsAndFolderSection;
