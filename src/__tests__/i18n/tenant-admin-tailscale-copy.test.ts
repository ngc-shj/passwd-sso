import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// C7 (harden-cli-tailnet-ssrf): tailscaleEnabledHelp / tailscaleTailnetHelp
// used to scope tailnet verification to "API/token access" only. C5 folded
// the WhoIs check into checkAccessRestriction, so it now applies to every
// browser session too — the old scope claim is false. C7's acceptance
// criterion is a one-time `rg` command; this test is the mechanism that
// keeps a later edit from silently reintroducing the stale claim.

function readMessages(locale: string, namespace: string): Record<string, string> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, `${namespace}.json`),
      "utf8",
    ),
  ) as Record<string, string>;
}

const HELP_KEYS = ["tailscaleEnabledHelp", "tailscaleTailnetHelp"] as const;

describe("TenantAdmin Tailscale help copy does not claim API/token-only scope", () => {
  it("[en] contains neither stale scope phrase", () => {
    const messages = readMessages("en", "TenantAdmin");
    for (const key of HELP_KEYS) {
      expect(messages[key]).not.toContain("API/token");
    }
  });

  it("[ja] contains neither stale scope phrase", () => {
    const messages = readMessages("ja", "TenantAdmin");
    for (const key of HELP_KEYS) {
      expect(messages[key]).not.toContain("APIアクセス");
    }
  });
});
