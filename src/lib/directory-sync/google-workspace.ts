/**
 * Google Workspace provider client for Directory Sync.
 *
 * Uses service-account JWT (RS256) to obtain an access token,
 * then calls the Admin SDK Directory API via plain fetch.
 */

import { createSign } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

export interface GoogleServiceAccount {
  /** service_account client_email */
  client_email: string;
  /** PEM-encoded RSA private key */
  private_key: string;
}

export interface GoogleCredentials {
  /** Parsed service-account JSON. */
  serviceAccount: GoogleServiceAccount;
  /** Workspace domain to sync (e.g. "example.com"). */
  domain: string;
  /** Admin email for domain-wide delegation. */
  adminEmail: string;
}

export interface GoogleUser {
  id: string;
  primaryEmail: string;
  name: { fullName: string };
  suspended: boolean;
}

export interface GoogleGroup {
  id: string;
  name: string;
  email: string;
}

import { DIRECTORY_SYNC_MAX_PAGES, DIRECTORY_SYNC_ERROR_PREVIEW } from "@/lib/validations/common.server";

// ─── Constants ──────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

// ─── Validation ──────────────────────────────────────────────

/** RFC 5321-ish domain validation (simple). */
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

function validateDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(
      `Invalid Google Workspace domain: "${domain.slice(0, 60)}"`,
    );
  }
}

// ─── JWT Helpers ─────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function createJwt(
  serviceAccount: GoogleServiceAccount,
  scopes: string[],
  adminEmail: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    sub: adminEmail,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600, // 1 hour
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  const signingInput = segments.join(".");
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(serviceAccount.private_key);

  return `${signingInput}.${base64url(signature)}`;
}

// ─── Token ───────────────────────────────────────────────────

const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
];

/**
 * Obtain an access token using service-account JWT assertion.
 */
export async function getGoogleAccessToken(
  serviceAccount: GoogleServiceAccount,
  domain: string,
  adminEmail: string,
): Promise<string> {
  validateDomain(domain);

  const jwt = createJwt(serviceAccount, DIRECTORY_SCOPES, adminEmail);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Google token request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
    );
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Google token response missing access_token");
  }

  return json.access_token;
}

// ─── Users ───────────────────────────────────────────────────

interface GoogleUsersResponse {
  users?: Array<{
    id: string;
    primaryEmail: string;
    name: { fullName: string };
    suspended: boolean;
  }>;
  nextPageToken?: string;
}

/**
 * Fetch all users from Google Workspace Admin SDK.
 * Handles pagination via nextPageToken.
 */
export async function fetchGoogleUsers(
  token: string,
  domain: string,
): Promise<GoogleUser[]> {
  validateDomain(domain);

  const users: GoogleUser[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Google users pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const params = new URLSearchParams({ domain });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://admin.googleapis.com/admin/directory/v1/users?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Google users request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as GoogleUsersResponse;
    if (json.users) {
      for (const u of json.users) {
        users.push({
          id: u.id,
          primaryEmail: u.primaryEmail,
          name: { fullName: u.name.fullName },
          suspended: u.suspended,
        });
      }
    }

    pageToken = json.nextPageToken;
  } while (pageToken);

  return users;
}

// ─── Groups ──────────────────────────────────────────────────

interface GoogleGroupsResponse {
  groups?: Array<{
    id: string;
    name: string;
    email: string;
  }>;
  nextPageToken?: string;
}

/**
 * Fetch all groups from Google Workspace Admin SDK.
 * Handles pagination via nextPageToken.
 */
export async function fetchGoogleGroups(
  token: string,
  domain: string,
): Promise<GoogleGroup[]> {
  validateDomain(domain);

  const groups: GoogleGroup[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    if (++pages > DIRECTORY_SYNC_MAX_PAGES) {
      throw new Error(`Google groups pagination exceeded ${DIRECTORY_SYNC_MAX_PAGES} pages`);
    }

    const params = new URLSearchParams({ domain });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://admin.googleapis.com/admin/directory/v1/groups?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Google groups request failed (${res.status}): ${text.slice(0, DIRECTORY_SYNC_ERROR_PREVIEW)}`,
      );
    }

    const json = (await res.json()) as GoogleGroupsResponse;
    if (json.groups) {
      for (const g of json.groups) {
        groups.push({
          id: g.id,
          name: g.name,
          email: g.email,
        });
      }
    }

    pageToken = json.nextPageToken;
  } while (pageToken);

  return groups;
}
