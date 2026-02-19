"use client";

import { useEffect, useState } from "react";
import { API_PATH } from "@/lib/constants";
import type { FolderItem } from "@/components/folders/folder-tree";

export function usePersonalFolders() {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const url = API_PATH.FOLDERS;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) {
          setFolders(data);
          setFetchError(null);
        }
      })
      .catch((e: unknown) => {
        setFetchError(
          `Failed to load ${url}: ${e instanceof Error ? e.message : "unknown"}`,
        );
      });
  }, []);

  return { folders, fetchError };
}
