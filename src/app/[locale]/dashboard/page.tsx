"use client";

import { useState, useRef, useEffect, Fragment } from "react";
import { useTranslations } from "next-intl";
import { Header } from "@/components/layout/header";
import { Sidebar, type SidebarView } from "@/components/layout/sidebar";
import { PasswordList, type SortOption } from "@/components/passwords/password-list";
import { TrashList } from "@/components/passwords/trash-list";
import { PasswordNewDialog } from "@/components/passwords/password-new-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, ArrowUpDown } from "lucide-react";

export default function DashboardPage() {
  const t = useTranslations("Dashboard");
  const ts = useTranslations("Shortcuts");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedView, setSelectedView] = useState<SidebarView>("all");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sortBy, setSortBy] = useState<SortOption>("updatedAt");
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Derive tagId and view mode from selectedView
  const isTrash = selectedView === "trash";
  const isFavorites = selectedView === "favorites";
  const isArchive = selectedView === "archive";
  const tagId = selectedView !== "all" && selectedView !== "favorites" && selectedView !== "trash" && selectedView !== "archive"
    ? selectedView
    : null;

  const title = isTrash
    ? t("trash")
    : isFavorites
      ? t("favorites")
      : isArchive
        ? t("archive")
        : t("passwords");

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA"
        || target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+K — focus search (works even in inputs)
      if (mod && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      // Escape — clear search or blur
      if (e.key === "Escape") {
        if (searchQuery) {
          setSearchQuery("");
          searchRef.current?.blur();
        }
        return;
      }

      // Skip single-key shortcuts when in input
      if (inInput) return;

      // / — focus search
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      // n — new password (not in trash/archive)
      if (e.key === "n") {
        e.preventDefault();
        if (!isTrash && !isArchive) setNewDialogOpen(true);
        return;
      }

      // ? — show shortcuts help
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchQuery, isTrash, isArchive]);

  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const mod = isMac ? "⌘" : "Ctrl+";

  const shortcuts: [string, string][] = [
    [`/ ${ts("or")} ${mod}K`, ts("search")],
    ["N", ts("newPassword")],
    ["Esc", ts("escape")],
    ["?", ts("help")],
  ];

  return (
    <div className="flex h-screen flex-col">
      <Header
        onMenuToggle={() => setSidebarOpen(true)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchRef={searchRef}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          selectedView={selectedView}
          onViewSelect={setSelectedView}
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          onImportComplete={() => setRefreshKey((k) => k + 1)}
          refreshKey={refreshKey}
        />
        <main className="flex-1 overflow-auto p-4 md:p-6">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-xl font-semibold">{title}</h1>
              <div className="flex items-center gap-2">
                {!isTrash && !isArchive && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <ArrowUpDown className="h-4 w-4 mr-1" />
                        {sortBy === "title" ? t("sortTitle") : sortBy === "createdAt" ? t("sortCreated") : t("sortUpdated")}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setSortBy("updatedAt")}>
                        {t("sortUpdated")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSortBy("createdAt")}>
                        {t("sortCreated")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSortBy("title")}>
                        {t("sortTitle")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {!isTrash && !isArchive && (
                  <Button onClick={() => setNewDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    {t("newPassword")}
                  </Button>
                )}
              </div>
            </div>
            {isTrash ? (
              <TrashList refreshKey={refreshKey} />
            ) : (
              <PasswordList
                searchQuery={searchQuery}
                tagId={tagId}
                refreshKey={refreshKey}
                favoritesOnly={isFavorites}
                archivedOnly={isArchive}
                sortBy={sortBy}
                onDataChange={() => setRefreshKey((k) => k + 1)}
              />
            )}
          </div>
        </main>
      </div>
      <PasswordNewDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{ts("title")}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {shortcuts.map(([keys, label]) => (
              <Fragment key={keys}>
                <kbd className="inline-flex items-center justify-end gap-0.5 font-mono text-xs text-muted-foreground">
                  {keys}
                </kbd>
                <span>{label}</span>
              </Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
