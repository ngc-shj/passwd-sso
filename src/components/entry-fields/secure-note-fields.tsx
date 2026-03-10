"use client";

import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SecureNoteMarkdown } from "@/components/passwords/secure-note-markdown";
import { SECURE_NOTE_MAX } from "@/lib/validations";

interface SecureNoteFieldsProps {
  content: string;
  onContentChange: (value: string) => void;
  contentLabel: string;
  contentPlaceholder: string;
  editTabLabel: string;
  previewTabLabel: string;
  markdownHint?: string;
  idPrefix?: string;
}

export function SecureNoteFields({
  content,
  onContentChange,
  contentLabel,
  contentPlaceholder,
  editTabLabel,
  previewTabLabel,
  markdownHint,
  idPrefix = "",
}: SecureNoteFieldsProps) {
  const contentId = `${idPrefix}content`;

  return (
    <div className="space-y-2">
      <Label htmlFor={contentId}>{contentLabel}</Label>
      {markdownHint && <p className="text-xs text-muted-foreground">{markdownHint}</p>}
      <Tabs defaultValue="edit">
        <TabsList className="grid w-full max-w-[200px] grid-cols-2">
          <TabsTrigger value="edit">{editTabLabel}</TabsTrigger>
          <TabsTrigger value="preview">{previewTabLabel}</TabsTrigger>
        </TabsList>
        <TabsContent value="edit" className="mt-2">
          <textarea
            id={contentId}
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            placeholder={contentPlaceholder}
            rows={10}
            maxLength={SECURE_NOTE_MAX}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </TabsContent>
        <TabsContent value="preview" className="mt-2">
          <div className="min-h-[240px] rounded-lg border bg-muted/30 p-3">
            {content ? (
              <SecureNoteMarkdown content={content} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {contentPlaceholder}
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
