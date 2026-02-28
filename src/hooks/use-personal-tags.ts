"use client";

import { useEffect, useState } from "react";
import { API_PATH } from "@/lib/constants";
import type { SidebarTagItem } from "@/hooks/use-sidebar-data";

export function usePersonalTags() {
  const [tags, setTags] = useState<SidebarTagItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const url = API_PATH.TAGS;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) {
          setTags(data);
          setFetchError(null);
        }
      })
      .catch((e: unknown) => {
        setFetchError(
          `Failed to load ${url}: ${e instanceof Error ? e.message : "unknown"}`,
        );
      });
  }, []);

  return { tags, fetchError };
}
