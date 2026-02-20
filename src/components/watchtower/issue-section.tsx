"use client";

import { useState } from "react";
import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ShieldAlert,
  Lock,
  Copy,
  Clock,
  Globe,
  Files,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import type { PasswordIssue, ReusedGroup, DuplicateGroup } from "@/hooks/use-watchtower";

// ─── Issue Category Card ─────────────────────────────────────

type IssueType = "breached" | "weak" | "reused" | "old" | "unsecured" | "expiring";

const issueConfig: Record<
  IssueType,
  { icon: typeof ShieldAlert; color: string; badgeVariant: "destructive" | "secondary" }
> = {
  breached: { icon: ShieldAlert, color: "text-red-500", badgeVariant: "destructive" },
  weak: { icon: Lock, color: "text-yellow-500", badgeVariant: "secondary" },
  reused: { icon: Copy, color: "text-orange-500", badgeVariant: "secondary" },
  old: { icon: Clock, color: "text-blue-500", badgeVariant: "secondary" },
  unsecured: { icon: Globe, color: "text-orange-600", badgeVariant: "secondary" },
  expiring: { icon: CalendarClock, color: "text-amber-500", badgeVariant: "secondary" },
};

interface IssueSectionProps {
  type: IssueType;
  title: string;
  description: string;
  issues: PasswordIssue[];
  formatDetails: (details: string) => string;
}

export function IssueSection({
  type,
  title,
  description,
  issues,
  formatDetails,
}: IssueSectionProps) {
  const [expanded, setExpanded] = useState(issues.length > 0);
  const config = issueConfig[type];
  const Icon = config.icon;

  return (
    <div className="rounded-xl border bg-card/80">
      <button
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon className={`h-5 w-5 shrink-0 ${config.color}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            <Badge variant={issues.length > 0 ? config.badgeVariant : "secondary"}>
              {issues.length}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {issues.length > 0 &&
          (expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ))}
      </button>

      {expanded && issues.length > 0 && (
        <div className="border-t divide-y">
          {issues.map((issue) => (
            <div
              key={issue.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{issue.title}</p>
                {issue.username && (
                  <p className="text-xs text-muted-foreground truncate">
                    {issue.username}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatDetails(issue.details)}
                </p>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/dashboard/${issue.id}`}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Reused Password Section ─────────────────────────────────

interface ReusedSectionProps {
  title: string;
  description: string;
  groups: ReusedGroup[];
  formatCount: (count: number) => string;
}

export function ReusedSection({
  title,
  description,
  groups,
  formatCount,
}: ReusedSectionProps) {
  const [expanded, setExpanded] = useState(groups.length > 0);
  const config = issueConfig.reused;
  const Icon = config.icon;

  return (
    <div className="rounded-xl border bg-card/80">
      <button
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon className={`h-5 w-5 shrink-0 ${config.color}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            <Badge variant={groups.length > 0 ? config.badgeVariant : "secondary"}>
              {groups.length}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {groups.length > 0 &&
          (expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ))}
      </button>

      {expanded && groups.length > 0 && (
        <div className="border-t divide-y">
          {groups.map((group, gi) => (
            <div key={gi} className="px-4 py-3">
              <p className="text-xs text-muted-foreground mb-2">
                {formatCount(group.entries.length)}
              </p>
              <div className="space-y-1">
                {group.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block">
                        {entry.title}
                      </span>
                      {entry.username && (
                        <span className="text-xs text-muted-foreground truncate block">
                          {entry.username}
                        </span>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/${entry.id}`}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Duplicate Entry Section ────────────────────────────────

interface DuplicateSectionProps {
  title: string;
  description: string;
  groups: DuplicateGroup[];
  formatCount: (count: number, hostname: string) => string;
}

export function DuplicateSection({
  title,
  description,
  groups,
  formatCount,
}: DuplicateSectionProps) {
  const [expanded, setExpanded] = useState(groups.length > 0);
  const Icon = Files;

  return (
    <div className="rounded-xl border bg-card/80">
      <button
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon className="h-5 w-5 shrink-0 text-purple-500" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            <Badge variant={groups.length > 0 ? "secondary" : "secondary"}>
              {groups.length}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {groups.length > 0 &&
          (expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ))}
      </button>

      {expanded && groups.length > 0 && (
        <div className="border-t divide-y">
          {groups.map((group, gi) => (
            <div key={gi} className="px-4 py-3">
              <p className="text-xs text-muted-foreground mb-2">
                {formatCount(group.entries.length, group.hostname)}
              </p>
              <div className="space-y-1">
                {group.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block">
                        {entry.title}
                      </span>
                      {entry.username && (
                        <span className="text-xs text-muted-foreground truncate block">
                          {entry.username}
                        </span>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/${entry.id}`}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
