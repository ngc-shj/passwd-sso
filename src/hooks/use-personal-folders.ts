"use client";

import { useEffect, useState } from "react";
import { API_PATH } from "@/lib/constants";
import type { FolderItem } from "@/components/folders/folder-tree";

export function usePersonalFolders() {
  const [folders, setFolders] = useState<FolderItem[]>([]);

  useEffect(() => {
    fetch(API_PATH.FOLDERS)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setFolders(data);
        }
      })
      .catch(() => {});
  }, []);

  return folders;
}
