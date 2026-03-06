"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

export function UserAvatar() {
  const { data: session } = useSession();
  const [imgLoaded, setImgLoaded] = useState(false);
  const user = session?.user;

  if (!user) {
    return (
      <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
    );
  }

  const initials = (user.name ?? user.email ?? "?")
    .split(/[\s@]/)
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

  return (
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
      {initials}
      {user.image && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={user.image}
          alt={user.name ?? "User"}
          className={`absolute inset-0 h-8 w-8 rounded-full object-cover transition-opacity ${imgLoaded ? "opacity-100" : "opacity-0"}`}
          referrerPolicy="no-referrer"
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgLoaded(false)}
        />
      )}
    </div>
  );
}
