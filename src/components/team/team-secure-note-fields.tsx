"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface OrgSecureNoteFieldsProps {
  content: string;
  onContentChange: (value: string) => void;
  contentLabel: string;
  contentPlaceholder: string;
}

export function OrgSecureNoteFields({
  content,
  onContentChange,
  contentLabel,
  contentPlaceholder,
}: OrgSecureNoteFieldsProps) {
  return (
    <div className="space-y-2">
      <Label>{contentLabel}</Label>
      <Textarea
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        placeholder={contentPlaceholder}
        rows={10}
        maxLength={50000}
        className="font-mono"
      />
    </div>
  );
}
