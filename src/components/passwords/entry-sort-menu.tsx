"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { EntrySortOption } from "@/lib/entry-sort";
import { ArrowUpDown } from "lucide-react";

interface EntrySortMenuProps {
  sortBy: EntrySortOption;
  onSortByChange: (sortBy: EntrySortOption) => void;
  labels: {
    updated: string;
    created: string;
    title: string;
  };
}

export function EntrySortMenu({
  sortBy,
  onSortByChange,
  labels,
}: EntrySortMenuProps) {
  const currentLabel =
    sortBy === "title"
      ? labels.title
      : sortBy === "createdAt"
        ? labels.created
        : labels.updated;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowUpDown className="h-4 w-4 mr-1" />
          {currentLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSortByChange("updatedAt")}>
          {labels.updated}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSortByChange("createdAt")}>
          {labels.created}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSortByChange("title")}>
          {labels.title}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
