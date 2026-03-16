/**
 * Azure AD (Entra ID) provider client for Directory Sync.
 *
 * Uses Microsoft Graph API via plain fetch — no external SDK.
 */

import { DIRECTORY_SYNC_MAX_PAGES, DIRECTORY_SYNC_ERROR_PREVIEW } from "@/lib/validations/common.server";

// ─── Types ───────────────────────────────────────────────────

export interface AzureAdCredentials {
  /** Azure AD tenant ID (UUID). */
  tenantId: string;
  /** Application (client) ID. */
  clientId: string;
  /** Client secret. */
  clientSecret: string;
}

export interface AzureAdUser {
  id: string;
  displayName: string;
  mail: string | null;
  accountEnabled: boolean;
}

export interface AzureAdGroup {
  id: string;
  displayName: string;
  members: string[]; // array of user IDs
}

// ─── Constants ──────────────────────────────────────────────

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const FETCH_TIMEOUT_MS = 30_000;

// ─── Validation ──────────────────────────────────────────────

const UUID_RE = /^[0-9a-f-]{36}$/i;

function validateTenantId(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(
      `Invalid Azure AD tenant ID: expected UUID, got "${tenantId.slice(0, 40)}"`,
    );
  }
}

/**
 * Validate that a pagination URL shares the expected Graph origin.
 * Prevents SSRF via attacker-controlled @odata.nextLink URLs.
 */
function validatePaginationUrl(paginationUrl: string): void {
  const parsed = new URL(paginationUrl);
  if (parsed.origin !== GRAPH_ORIGIN) {
    throw new Error(
      `Pagination URL origin mismatch: expected "${GRAPH_ORIGIN}", got "${parsed.origin}"`,
    );
  }
}

// ─── Token ───────────────────────────────────────────────────

/**
 * Obtain an access token via OAuth2 client-credentials grant.
 */
export async function getAzureAdToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  validateTenantId(tenantId);

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Azure AD token request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
    );
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Azure AD token response missing access_token");
  }

  return json.access_token;
}

// ─── Users ───────────────────────────────────────────────────

interface GraphUserResponse {
  value: Array<{
    id: string;
    displayName: string;
    mail: string | null;
    accountEnabled: boolean;
  }>;
  "@odata.nextLink"?: string;
}

/**
 * Fetch all users from Azure AD / Microsoft Graph.
 * Handles pagination via @odata.nextLink.
 */
export async function fetchAzureAdUsers(
  token: string,
): Promise<AzureAdUser[]> {
  const users: AzureAdUser[] = [];
  let url: string | undefined =
    "https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,accountEnabled";
  let pages = 0;

  while (url) {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Azure AD users pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Azure AD users request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as GraphUserResponse;
    for (const u of json.value) {
      users.push({
        id: u.id,
        displayName: u.displayName,
        mail: u.mail,
        accountEnabled: u.accountEnabled,
      });
    }

    const nextLink = json["@odata.nextLink"];
    if (nextLink) {
      validatePaginationUrl(nextLink);
    }
    url = nextLink;
  }

  return users;
}

// ─── Groups ──────────────────────────────────────────────────

interface GraphGroupResponse {
  value: Array<{
    id: string;
    displayName: string;
  }>;
  "@odata.nextLink"?: string;
}

interface GraphGroupMembersResponse {
  value: Array<{
    "@odata.type": string;
    id: string;
  }>;
  "@odata.nextLink"?: string;
}

/**
 * Fetch all groups and their user members from Azure AD.
 * Handles pagination for both group listing and member listing.
 */
export async function fetchAzureAdGroups(
  token: string,
): Promise<AzureAdGroup[]> {
  const groups: AzureAdGroup[] = [];

  // Fetch all groups
  let url: string | undefined =
    "https://graph.microsoft.com/v1.0/groups?$select=id,displayName";
  let pages = 0;

  while (url) {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Azure AD groups pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Azure AD groups request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as GraphGroupResponse;

    for (const g of json.value) {
      // Fetch members for each group
      const members = await fetchGroupMembers(token, g.id);
      groups.push({
        id: g.id,
        displayName: g.displayName,
        members,
      });
    }

    const nextLink = json["@odata.nextLink"];
    if (nextLink) {
      validatePaginationUrl(nextLink);
    }
    url = nextLink;
  }

  return groups;
}

/**
 * Fetch user member IDs for a single group.
 * Filters to "#microsoft.graph.user" type only.
 */
async function fetchGroupMembers(
  token: string,
  groupId: string,
): Promise<string[]> {
  const memberIds: string[] = [];
  let url: string | undefined =
    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}/members?$select=id`;
  let pages = 0;

  while (url) {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Azure AD group members pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Azure AD group members request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as GraphGroupMembersResponse;
    for (const m of json.value) {
      if (m["@odata.type"] === "#microsoft.graph.user") {
        memberIds.push(m.id);
      }
    }

    const nextLink = json["@odata.nextLink"];
    if (nextLink) {
      validatePaginationUrl(nextLink);
    }
    url = nextLink;
  }

  return memberIds;
}
