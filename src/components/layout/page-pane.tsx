"use client";

import type { ReactNode } from "react";

interface PagePaneProps {
  header?: ReactNode;
  children: ReactNode;
}

export function PagePane({ header, children }: PagePaneProps) {
  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {header}
        {children}
      </div>
    </div>
  );
}
