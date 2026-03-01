"use client";

import type { ReactNode } from "react";

interface FloatingActionBarProps {
  visible: boolean;
  position: "sticky" | "fixed";
  children: ReactNode;
}

const sharedBarClasses =
  "flex items-center justify-end rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80";

export function FloatingActionBar({
  visible,
  position,
  children,
}: FloatingActionBarProps) {
  if (!visible) return null;

  if (position === "fixed") {
    return (
      <div className="fixed bottom-4 inset-x-0 z-40 flex justify-center px-4 md:pl-60 pointer-events-none">
        <div
          className={`pointer-events-auto w-full max-w-4xl ${sharedBarClasses}`}
        >
          <div className="flex items-center gap-2">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`sticky bottom-4 z-40 mt-2 ${sharedBarClasses}`}>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
