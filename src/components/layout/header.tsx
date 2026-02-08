"use client";

import { useState, useEffect, type RefObject } from "react";
import { useSession } from "next-auth/react";
import { KeyRound, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/auth/user-avatar";
import { SignOutButton } from "@/components/auth/signout-button";
import { SearchBar } from "./search-bar";
import { LanguageSwitcher } from "./language-switcher";

interface HeaderProps {
  onMenuToggle: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
}

export function Header({
  onMenuToggle,
  searchQuery,
  onSearchChange,
  searchRef,
}: HeaderProps) {
  const { data: session } = useSession();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center gap-4 px-4">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onMenuToggle}
        >
          <Menu className="h-5 w-5" />
        </Button>

        <div className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-5 w-5" />
          <span className="hidden sm:inline">passwd-sso</span>
        </div>

        <div className="flex-1 max-w-md mx-auto">
          <SearchBar ref={searchRef} value={searchQuery} onChange={onSearchChange} />
        </div>

        {mounted && <LanguageSwitcher />}

        {mounted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2 px-2">
                <UserAvatar />
                <span className="hidden sm:inline text-sm">
                  {session?.user?.name}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-xs text-muted-foreground" disabled>
                {session?.user?.email}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <SignOutButton />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" className="gap-2 px-2">
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
          </Button>
        )}
      </div>
    </header>
  );
}
