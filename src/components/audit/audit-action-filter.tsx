"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ChevronDown } from "lucide-react";
import type { AuditActionValue } from "@/lib/constants";
import type { ActionGroupDef } from "@/hooks/vault/use-audit-logs";

interface AuditActionFilterProps {
  actionGroups: readonly ActionGroupDef[];
  selectedActions: Set<AuditActionValue>;
  actionSearch: string;
  filterOpen: boolean;
  actionSummary: string;
  actionLabel: (action: AuditActionValue | string) => string;
  filteredActions: (actions: readonly AuditActionValue[]) => readonly AuditActionValue[];
  isActionSelected: (action: AuditActionValue) => boolean;
  toggleAction: (action: AuditActionValue, checked: boolean) => void;
  setGroupSelection: (actions: readonly AuditActionValue[], checked: boolean) => void;
  clearActions: () => void;
  setActionSearch: (v: string) => void;
  setFilterOpen: (v: boolean) => void;
  groupLabelResolver?: (groupValue: string) => string | undefined;
}

export function AuditActionFilter({
  actionGroups,
  selectedActions,
  actionSearch,
  filterOpen,
  actionSummary,
  actionLabel,
  filteredActions,
  isActionSelected,
  toggleAction,
  setGroupSelection,
  clearActions,
  setActionSearch,
  setFilterOpen,
  groupLabelResolver,
}: AuditActionFilterProps) {
  const t = useTranslations("AuditLog");

  const resolveGroupLabel = (group: ActionGroupDef): string => {
    if (groupLabelResolver) {
      const resolved = groupLabelResolver(group.value);
      if (resolved !== undefined) {
        return t.has(resolved as never) ? t(resolved as never) : resolved;
      }
    }
    return t(group.label as never);
  };

  return (
    <Collapsible open={filterOpen} onOpenChange={setFilterOpen}>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="justify-between gap-2">
            <span className="text-xs">{t("action")}: {actionSummary}</span>
            <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${filterOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        {selectedActions.size > 0 && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearActions}>
            {t("allActions")}
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <div className="mt-2 space-y-2">
          <Input
            placeholder={t("actionSearch")}
            value={actionSearch}
            onChange={(e) => setActionSearch(e.target.value)}
          />
          <div className="max-h-64 overflow-y-auto border rounded-md p-3 space-y-1">
            {actionGroups.map((group) => {
              const actions = filteredActions(group.actions);
              if (actions.length === 0) return null;
              const allSelected = group.actions.every((a) => selectedActions.has(a));
              return (
                <Collapsible key={group.value}>
                  <div className="flex items-center gap-2 py-1">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) => setGroupSelection(group.actions, !!checked)}
                    />
                    <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium hover:underline">
                      {resolveGroupLabel(group)}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="pl-6 space-y-1">
                    {actions.map((action) => (
                      <label key={action} className="flex items-center gap-2 text-sm py-0.5">
                        <Checkbox
                          checked={isActionSelected(action)}
                          onCheckedChange={(checked) => toggleAction(action, !!checked)}
                        />
                        {actionLabel(action)}
                      </label>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
