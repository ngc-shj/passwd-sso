export interface NavigationTarget {
  isInternal: boolean;
  internalPath?: string;
  externalHref: string;
}

export function resolveNavigationTarget(
  href: string,
  currentOrigin: string
): NavigationTarget {
  const nextUrl = new URL(href, currentOrigin);
  const isInternal = nextUrl.origin === currentOrigin;

  if (isInternal) {
    return {
      isInternal: true,
      internalPath: `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      externalHref: nextUrl.href,
    };
  }

  return {
    isInternal: false,
    externalHref: nextUrl.href,
  };
}

