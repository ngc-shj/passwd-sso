/**
 * Whether every role connection string names the same host, port and database
 * as the superuser one. The suite seeds through the superuser and asserts
 * through the role clients; a role URL that points at another database would
 * make each cell read rows it never wrote, or run enforcement against a
 * database that is not the one setup.ts checked.
 *
 * Returns one line per mismatch, naming host:port/database only: a connection
 * string carries a password, and this text lands in an error message.
 */
function endpointOf(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

export function roleUrlMismatches(
  superuserUrl: string,
  roleUrls: Readonly<Record<string, string>>,
): string[] {
  const expected = endpointOf(superuserUrl);
  const mismatches: string[] = [];
  for (const [role, roleUrl] of Object.entries(roleUrls)) {
    const actual = endpointOf(roleUrl);
    if (actual !== expected) mismatches.push(`${role}: ${actual} (superuser: ${expected})`);
  }
  return mismatches;
}
