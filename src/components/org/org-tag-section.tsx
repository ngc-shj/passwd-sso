"use client";

import { EntryTagsSection } from "@/components/passwords/entry-tags-section";
import { OrgTagInput, type OrgTagData } from "@/components/org/org-tag-input";

interface OrgTagSectionProps {
  title: string;
  hint: string;
  orgId: string;
  selectedTags: OrgTagData[];
  onChange: (tags: OrgTagData[]) => void;
  sectionCardClass?: string;
}

export function OrgTagSection({
  title,
  hint,
  orgId,
  selectedTags,
  onChange,
  sectionCardClass = "",
}: OrgTagSectionProps) {
  return (
    <EntryTagsSection title={title} hint={hint} sectionCardClass={sectionCardClass}>
      <OrgTagInput orgId={orgId} selectedTags={selectedTags} onChange={onChange} />
    </EntryTagsSection>
  );
}
