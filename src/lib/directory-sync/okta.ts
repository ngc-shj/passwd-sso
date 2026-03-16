/**
 * Okta provider client for Directory Sync.
 *
 * Uses the Okta REST API via plain fetch — no external SDK.
 */

// ─── Types ───────────────────────────────────────────────────

export interface OktaCredentials {
  /** Okta org URL, e.g. "https://dev-12345.okta.com/" */
  orgUrl: string;
  /** Okta API token (SSWS). */
  apiToken: string;
}

export interface OktaUser {
  id: string;
  status: string;
  profile: {
    login: string;
    email: string;
    firstName: string;
    lastName: string;
    displayName?: string;
  };
}

export interface OktaGroup {
  id: string;
  profile: {
    name: string;
    description?: string;
  };
}

import { DIRECTORY_SYNC_MAX_PAGES, DIRECTORY_SYNC_ERROR_PREVIEW } from "@/lib/validations/common.server";

// ─── Constants ──────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

// ─── Validation ──────────────────────────────────────────────

/** Okta org URL must be https://<subdomain>.okta.com/ or .oktapreview.com/ */
const OKTA_ORG_RE = /^https:\/\/[a-zA-Z0-9-]+\.okta(preview)?\.com\/$/;

function validateOrgUrl(orgUrl: string): void {
  if (!OKTA_ORG_RE.test(orgUrl)) {
    throw new Error(
      `Invalid Okta org URL: expected "https://<subdomain>.okta.com/", got "${orgUrl.slice(0, 80)}"`,
    );
  }
}

// ─── Pagination Helper ──────────────────────────────────────

/**
 * Validate that a pagination URL shares the same origin as the initial request.
 * Prevents SSRF via attacker-controlled pagination URLs in IdP responses.
 */
function validatePaginationUrl(paginationUrl: string, initialUrl: string): void {
  const pagination = new URL(paginationUrl);
  const initial = new URL(initialUrl);
  if (pagination.origin !== initial.origin) {
    throw new Error(
      `Pagination URL origin mismatch: expected "${initial.origin}", got "${pagination.origin}"`,
    );
  }
}

/**
 * Parse the Link header to find the "next" URL.
 * Okta uses: `<https://...>; rel="next"`
 */
function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;

  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }

  return undefined;
}

// ─── Users ───────────────────────────────────────────────────

/**
 * Fetch all active users from Okta.
 * Handles pagination via Link header.
 */
export async function fetchOktaUsers(
  orgUrl: string,
  apiToken: string,
): Promise<OktaUser[]> {
  validateOrgUrl(orgUrl);

  const users: OktaUser[] = [];
  const params = new URLSearchParams({
    filter: 'status eq "ACTIVE"',
    limit: "200",
  });
  const initialUrl = `${orgUrl}api/v1/users?${params.toString()}`;
  let url: string | undefined = initialUrl;
  let pages = 0;

  while (url) {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Okta users pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `SSWS ${apiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Okta users request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as Array<{
      id: string;
      status: string;
      profile: {
        login: string;
        email: string;
        firstName: string;
        lastName: string;
        displayName?: string;
      };
    }>;

    for (const u of json) {
      users.push({
        id: u.id,
        status: u.status,
        profile: {
          login: u.profile.login,
          email: u.profile.email,
          firstName: u.profile.firstName,
          lastName: u.profile.lastName,
          displayName: u.profile.displayName,
        },
      });
    }

    const nextUrl = parseNextLink(res.headers.get("link"));
    if (nextUrl) {
      validatePaginationUrl(nextUrl, initialUrl);
    }
    url = nextUrl;
  }

  return users;
}

// ─── Groups ──────────────────────────────────────────────────

/**
 * Fetch all groups from Okta.
 * Handles pagination via Link header.
 */
export async function fetchOktaGroups(
  orgUrl: string,
  apiToken: string,
): Promise<OktaGroup[]> {
  validateOrgUrl(orgUrl);

  const groups: OktaGroup[] = [];
  const initialUrl = `${orgUrl}api/v1/groups?limit=200`;
  let url: string | undefined = initialUrl;
  let pages = 0;

  while (url) {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Okta groups pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `SSWS ${apiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Okta groups request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as Array<{
      id: string;
      profile: {
        name: string;
        description?: string;
      };
    }>;

    for (const g of json) {
      groups.push({
        id: g.id,
        profile: {
          name: g.profile.name,
          description: g.profile.description,
        },
      });
    }

    const nextUrl = parseNextLink(res.headers.get("link"));
    if (nextUrl) {
      validatePaginationUrl(nextUrl, initialUrl);
    }
    url = nextUrl;
  }

  return groups;
}
