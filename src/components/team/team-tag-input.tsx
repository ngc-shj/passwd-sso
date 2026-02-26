"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { apiPath } from "@/lib/constants";

export interface TeamTagData {
  id: string;
  name: string;
  color: string | null;
}

export type OrgTagData = TeamTagData;

interface TeamTagInputProps {
  teamId: string;
  selectedTags: TeamTagData[];
  onChange: (tags: TeamTagData[]) => void;
}

export function TeamTagInput({ teamId, selectedTags, onChange }: TeamTagInputProps) {
  const t = useTranslations("Tag");
  const tApi = useTranslations("ApiErrors");
  const [allTags, setAllTags] = useState<TeamTagData[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(apiPath.teamTags(teamId));
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setAllTags(data);
    } catch {
      // ignore
    }
  }, [teamId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedIds = new Set(selectedTags.map((t) => t.id));

  const filteredTags = allTags.filter(
    (tag) =>
      !selectedIds.has(tag.id) &&
      tag.name.toLowerCase().includes(inputValue.toLowerCase())
  );

  const exactMatch = allTags.find(
    (tag) => tag.name.toLowerCase() === inputValue.trim().toLowerCase()
  );

  const canCreate = inputValue.trim().length > 0 && !exactMatch;

  const addTag = (tag: TeamTagData) => {
    onChange([...selectedTags, tag]);
    setInputValue("");
    setShowDropdown(false);
  };

  const removeTag = (tagId: string) => {
    onChange(selectedTags.filter((t) => t.id !== tagId));
  };

  const createAndAddTag = async () => {
    if (!inputValue.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch(apiPath.teamTags(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: inputValue.trim() }),
      });
      if (res.ok) {
        const newTag: TeamTagData = await res.json();
        setAllTags((prev) => [...prev, newTag]);
        addTag(newTag);
      } else {
        const err = await res.json().catch(() => null);
        toast.error(tApi(apiErrorToI18nKey(err?.error)));
      }
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (filteredTags.length > 0 && !canCreate) {
        addTag(filteredTags[0]);
      } else if (canCreate) {
        createAndAddTag();
      }
    }
    if (e.key === "Escape" && showDropdown) {
      setShowDropdown(false);
    }
  };

  return (
    <div ref={containerRef} className="space-y-2" data-escape-guard={showDropdown || undefined}>
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => {
            const colorClass = getTagColorClass(tag.color);
            return (
              <Badge
                key={tag.id}
                variant="secondary"
                className={cn(
                  "gap-1 pr-1",
                  colorClass && "tag-color",
                  colorClass
                )}
              >
                {tag.name}
                <button
                  type="button"
                  onClick={() => removeTag(tag.id)}
                  className="ml-0.5 rounded-full hover:bg-muted p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      <div className="relative">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1 text-muted-foreground h-8 px-2"
          onClick={() => {
            setShowDropdown(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addTag")}
        </Button>

        {showDropdown && (
          <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border bg-popover p-2 shadow-md">
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("searchOrCreate")}
              className="h-8 text-sm"
              autoFocus
            />
            <div className="mt-1 max-h-40 overflow-y-auto">
              {filteredTags.map((tag) => {
                const colorClass = getTagColorClass(tag.color);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
                    onClick={() => addTag(tag)}
                  >
                    {tag.color && (
                      <span
                        className={cn(
                          "h-2.5 w-2.5 rounded-full shrink-0",
                          colorClass && "tag-color-bg",
                          colorClass
                        )}
                      />
                    )}
                    {tag.name}
                  </button>
                );
              })}
              {canCreate && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-primary hover:bg-accent"
                  onClick={createAndAddTag}
                  disabled={creating}
                >
                  {creating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {t("createTag", { name: inputValue.trim() })}
                </button>
              )}
              {filteredTags.length === 0 && !canCreate && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  {t("noTags")}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const OrgTagInput = TeamTagInput;
