"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface TeamSecureNoteFieldsProps {
  content: string;
  onContentChange: (value: string) => void;
  contentLabel: string;
  contentPlaceholder: string;
}

export function TeamSecureNoteFields({
  content,
  onContentChange,
  contentLabel,
  contentPlaceholder,
}: TeamSecureNoteFieldsProps) {
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
