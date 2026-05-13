"use client";

import { useEffect, useState } from "react";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import type { SidebarTagItem } from "@/hooks/sidebar/use-sidebar-data";

export function usePersonalTags() {
  const [tags, setTags] = useState<SidebarTagItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const url = API_PATH.TAGS;
    (async () => {
      try {
        const res = await fetchApi(url);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (Array.isArray(data)) {
          setTags(data);
          setFetchError(null);
        }
      } catch (e: unknown) {
        setFetchError(
          `Failed to load ${url}: ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
    })();
  }, []);

  return { tags, fetchError };
}
