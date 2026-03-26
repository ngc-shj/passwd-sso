"use client";

import type { ReactNode } from "react";

interface FloatingActionBarProps {
  visible: boolean;
  children: ReactNode;
}

export function FloatingActionBar({
  visible,
  children,
}: FloatingActionBarProps) {
  if (!visible) return null;

  return (
    <div className="sticky bottom-4 z-40 mt-2 flex items-center justify-end rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
