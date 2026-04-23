export interface NavigationTarget {
  isInternal: boolean;
  internalPath?: string;
  externalHref: string;
}

function normalizeForRouter(pathWithQueryHash: string, locale: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  let path = pathWithQueryHash;
  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || "/";
  }
  const localePrefix = `/${locale}`;
  if (path === localePrefix) return "/";
  if (path.startsWith(`${localePrefix}/`)) {
    return path.slice(localePrefix.length);
  }
  return path;
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

