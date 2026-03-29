import type { ReactNode } from "react";

interface AuditLogItemRowProps {
  id: string;
  icon: ReactNode;
  actionLabel: string;
  badges?: ReactNode;
  detail?: ReactNode;
  timestamp: string;
  ip?: string | null;
}

export function AuditLogItemRow({
  id,
  icon,
  actionLabel,
  badges,
  detail,
  timestamp,
  ip,
}: AuditLogItemRowProps) {
  return (
    <div
      key={id}
      data-testid="audit-log-row"
      className="px-4 py-3 flex items-start gap-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
    >
      <div className="shrink-0 text-muted-foreground mt-0.5">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium">{actionLabel}</p>
          {badges}
        </div>
        {detail}
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs text-muted-foreground whitespace-nowrap">
          {timestamp}
        </p>
        {ip && (
          <p className="text-xs text-muted-foreground">{ip}</p>
        )}
      </div>
    </div>
  );
}
