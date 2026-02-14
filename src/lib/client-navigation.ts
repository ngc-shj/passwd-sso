export interface NavigationTarget {
  isInternal: boolean;
  internalPath?: string;
  externalHref: string;
}

function normalizeForRouter(pathWithQueryHash: string, locale: string): string {
  const localePrefix = `/${locale}`;
  if (pathWithQueryHash === localePrefix) return "/";
  if (pathWithQueryHash.startsWith(`${localePrefix}/`)) {
    return pathWithQueryHash.slice(localePrefix.length);
  }
  return pathWithQueryHash;
}

export function resolveNavigationTarget(
  href: string,
  currentOrigin: string,
  locale: string
): NavigationTarget {
  const nextUrl = new URL(href, currentOrigin);
  const isInternal = nextUrl.origin === currentOrigin;

  if (isInternal) {
    const rawPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    return {
      isInternal: true,
      internalPath: normalizeForRouter(rawPath, locale),
      externalHref: nextUrl.href,
    };
  }

  return {
    isInternal: false,
    externalHref: nextUrl.href,
  };
}

