/**
 * The tenant-mismatch check on the MCP consent page.
 *
 * Round 2 found this comparison had no test at all — `grep McpConsentPage` over
 * the suite returned nothing, and the sibling file tests the client component
 * only. It is an authorization decision: an admin-created client is shown to a
 * user only when the client's tenant matches theirs, and this branch changed
 * WHICH tenant "theirs" means.
 *
 * A server component, so the page is invoked directly and its returned element
 * inspected. Only `ConsentForm` is stubbed — replacing it with a marker is what
 * lets "the form rendered" be told apart from "the mismatch screen rendered"
 * without asserting on translated copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockMcpClientFindFirst,
  mockUserFindUnique,
  mockWithBypassRls,
  mockRedirect,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMcpClientFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: { findFirst: mockMcpClientFindFirst },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));
// Keyed translations, so a cell can name the branch it expects without
// depending on message copy.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => `t:${key}`,
}));
// Stubbed with a marker PROP, not a marker return value: a React element
// serializes its props but not its component function, so a string return is
// invisible to the assertion below.
vi.mock("./consent-form", () => ({
  ConsentForm: () => null,
}));

import McpConsentPage from "./page";

const CLIENT_ID = "client-1";
const REDIRECT_URI = "https://client.example/cb";

const VALID_PARAMS = {
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  code_challenge: "a".repeat(43),
  scope: "passwords:read",
};

function seedClient(tenantId: string | null) {
  mockMcpClientFindFirst.mockResolvedValue({
    clientId: CLIENT_ID,
    clientName: "Test Client",
    tenantId,
    isActive: true,
    redirectUris: [REDIRECT_URI],
    allowedScopes: "passwords:read",
  });
}

/** The user read as `resolveOwningTenantIdFromClient` selects it. */
function seedUser(columnTenant: string, membershipTenant: string) {
  mockUserFindUnique.mockResolvedValue({
    tenantId: columnTenant,
    tenantMemberships: [{ tenantId: membershipTenant }],
  });
}

/**
 * The rendered tree, flattened for branch identification. `ConsentForm` is
 * stubbed to render nothing, so the branch is told by the props the page passed
 * it (`clientId`) versus the translation key the error screens render.
 */
function render(el: unknown): string {
  return JSON.stringify(el);
}

async function invoke() {
  return McpConsentPage({ searchParams: Promise.resolve(VALID_PARAMS) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockWithBypassRls.mockImplementation(
    (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
  );
});

describe("McpConsentPage tenant check", () => {
  it("admits the user when the client's tenant is their ACTIVE MEMBERSHIP's", async () => {
    // The allow half, and the discriminating one: the column says a different
    // tenant. Before the migration this rendered the mismatch screen for a user
    // who does belong to the client's tenant.
    seedClient("scim-provisioned-tenant");
    seedUser("stale-home-tenant", "scim-provisioned-tenant");

    const out = render(await invoke());

    expect(out).toContain('"clientId":"client-1"');
    expect(out).not.toContain("tenantMismatch");
  });

  it("refuses when the client belongs to neither of the user's tenants", async () => {
    // The deny half. Without it, a page that always rendered the form would
    // satisfy the cell above.
    seedClient("a-third-tenant");
    seedUser("stale-home-tenant", "scim-provisioned-tenant");

    const out = render(await invoke());

    expect(out).toContain("tenantMismatch");
    expect(out).not.toContain('"clientId"');
  });

  it("refuses when the client's tenant is the STALE column's, not the membership's", async () => {
    // The direction that matters. Matching on the column would admit here — the
    // client belongs to a tenant the user has no active membership in.
    seedClient("stale-home-tenant");
    seedUser("stale-home-tenant", "scim-provisioned-tenant");

    const out = render(await invoke());

    expect(out).toContain("tenantMismatch");
    expect(out).not.toContain('"clientId"');
  });

  it("skips the tenant check entirely for an unclaimed DCR client", async () => {
    // `client.tenantId === null` means the client has not been claimed yet;
    // claiming happens on Allow. The guard must not fire here, or dynamic
    // registration cannot complete.
    seedClient(null);
    seedUser("stale-home-tenant", "scim-provisioned-tenant");

    const out = render(await invoke());

    expect(out).toContain('"clientId":"client-1"');
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
