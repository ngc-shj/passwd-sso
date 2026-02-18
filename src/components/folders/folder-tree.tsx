"use client";

import { FolderOpen } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  entryCount: number;
}

interface FolderTreeProps {
  folders: FolderItem[];
  activeFolderId: string | null;
  onNavigate?: () => void;
}

interface TreeNode extends FolderItem {
  children: TreeNode[];
}

function buildTree(folders: FolderItem[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const f of folders) {
    map.set(f.id, { ...f, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function FolderNode({
  node,
  activeFolderId,
  depth,
  onNavigate,
}: {
  node: TreeNode;
  activeFolderId: string | null;
  depth: number;
  onNavigate?: () => void;
}) {
  return (
    <>
      <Button
        variant={activeFolderId === node.id ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        asChild
      >
        <Link
          href={`/dashboard/folders/${node.id}`}
          onClick={() => onNavigate?.()}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="truncate">{node.name}</span>
          {node.entryCount > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">
              {node.entryCount}
            </span>
          )}
        </Link>
      </Button>
      {node.children.map((child) => (
        <FolderNode
          key={child.id}
          node={child}
          activeFolderId={activeFolderId}
          depth={depth + 1}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

export function FolderTree({ folders, activeFolderId, onNavigate }: FolderTreeProps) {
  const tree = buildTree(folders);

  if (tree.length === 0) return null;

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <FolderNode
          key={node.id}
          node={node}
          activeFolderId={activeFolderId}
          depth={0}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
