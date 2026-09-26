"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * `nonce` is not optional in practice: next-themes emits an inline
 * `<script>` during SSR to apply the theme before first paint, and creates a
 * `<style>` at runtime for `disableTransitionOnChange`. Under the production
 * CSP both are blocked without it — the script silently, so the page renders
 * in the wrong theme until hydration. It stays optional in the type because
 * a request that reached a page outside the proxy's matcher has no nonce to
 * pass, and next-themes treats an empty value as absent.
 */
export function ThemeProvider({
  children,
  nonce,
}: {
  children: React.ReactNode;
  nonce?: string;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
