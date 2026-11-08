import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The team rotation / re-key copy speaks the team-key vocabulary the UI
// already uses: no "item key" (an internal name), and a team key version
// number only where a member must name the version to compare their copy of
// it with another holder (rekeyKeySuspicion).

function readMessages(locale: string, namespace: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(process.cwd(), "messages", locale, `${namespace}.json`), "utf8"),
  ) as Record<string, string>;
}

const VERSION_ALLOWED = new Set(["rekeyKeySuspicion"]);

describe.each([
  ["en", /item ?key/i],
  ["ja", /アイテムキー/],
])("[%s] Teams rotation and re-key copy", (locale, internalName) => {
  const entries = Object.entries(readMessages(locale, "Teams")).filter(
    ([key]) => key.startsWith("rekey") || key.startsWith("rotateKey"),
  );

  it("does not name the ItemKey", () => {
    expect(entries.filter(([, text]) => internalName.test(text)).map(([key]) => key)).toEqual([]);
  });

  it("shows a team key version only in the key-suspicion message", () => {
    expect(entries.filter(([, text]) => text.includes("{version}")).map(([key]) => key)).toEqual(
      [...VERSION_ALLOWED],
    );
  });
});
