"use client";

import { useState } from "react";
import { Globe } from "lucide-react";

interface FaviconProps {
  host: string | null;
  size?: number;
  className?: string;
}

export function Favicon({ host, size = 16, className }: FaviconProps) {
  const [error, setError] = useState(false);

  if (!host || error) {
    return <Globe className={className} style={{ width: size, height: size }} />;
  }

  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size * 2}`}
      alt=""
      width={size}
      height={size}
      className={className ?? "shrink-0"}
      referrerPolicy="no-referrer"
      onError={() => setError(true)}
    />
  );
}
