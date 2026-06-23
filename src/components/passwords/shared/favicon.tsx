"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Globe } from "lucide-react";
import { withBasePath } from "@/lib/url-helpers";

interface FaviconProps {
  host: string | null;
  size?: number;
  className?: string;
}

export function Favicon({ host, size = 16, className }: FaviconProps) {
  const [error, setError] = useState(false);
  const { data: session, status } = useSession();

  // Preference not yet known — render a neutral sized placeholder (no img, no globe)
  // to avoid list-wide globe→favicon flicker for opted-in users on first paint.
  if (status === "loading") {
    return <span style={{ display: "inline-block", width: size, height: size }} />;
  }

  const fetchFavicons = session?.user?.fetchFavicons === true;

  // Resolved OFF, or error, or no host: render Globe fallback
  if (!fetchFavicons || !host || error) {
    return <Globe className={className} style={{ width: size, height: size }} />;
  }

  // Bucket-snap the proxy size: renderPx * 2 <= 32 → 32, else → 64
  const proxySize = size * 2 <= 32 ? 32 : 64;
  const src = withBasePath(
    `/api/user/favicon?host=${encodeURIComponent(host)}&size=${proxySize}`
  );

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={className ?? "shrink-0"}
      referrerPolicy="no-referrer"
      onError={() => setError(true)}
    />
  );
}
