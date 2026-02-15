"use client";

import { useSession } from "next-auth/react";

export function UserAvatar() {
  const { data: session } = useSession();

  if (!session?.user) {
    return (
      <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
    );
  }

  const initials = session.user.name
    ? session.user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "??";

  return session.user.image ? (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={session.user.image}
      alt={session.user.name ?? "User"}
      className="h-8 w-8 rounded-full"
      referrerPolicy="no-referrer"
    />
  ) : (
    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
      {initials}
    </div>
  );
}
