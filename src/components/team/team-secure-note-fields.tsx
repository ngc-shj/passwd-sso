"use client";

import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SecureNoteMarkdown } from "@/components/passwords/secure-note-markdown";

interface TeamSecureNoteFieldsProps {
  content: string;
  onContentChange: (value: string) => void;
  contentLabel: string;
  contentPlaceholder: string;
  editTabLabel: string;
  previewTabLabel: string;
  markdownHint?: string;
}

export function TeamSecureNoteFields({
  content,
  onContentChange,
  contentLabel,
  contentPlaceholder,
  editTabLabel,
  previewTabLabel,
  markdownHint,
}: TeamSecureNoteFieldsProps) {
  return (
    <div className="space-y-2">
      <Label>{contentLabel}</Label>
      {markdownHint && <p className="text-xs text-muted-foreground">{markdownHint}</p>}
      <Tabs defaultValue="edit">
        <TabsList className="grid w-full max-w-[200px] grid-cols-2">
          <TabsTrigger value="edit">{editTabLabel}</TabsTrigger>
          <TabsTrigger value="preview">{previewTabLabel}</TabsTrigger>
        </TabsList>
        <TabsContent value="edit" className="mt-2">
          <textarea
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            placeholder={contentPlaceholder}
            rows={10}
            maxLength={50000}
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
