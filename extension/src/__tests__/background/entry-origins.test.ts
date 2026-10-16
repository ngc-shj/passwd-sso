import { describe, it, expect } from "vitest";
import { savedUrlOrigins } from "../../background/entry-origins";

describe("savedUrlOrigins", () => {
  it.each<[string, { url?: unknown; customFields?: unknown }, string[]]>([
    ["normalizes the entry url", { url: "https://Example.com:443/login" }, ["https://example.com"]],
    ["keeps an http url with its port", { url: "http://10.0.0.1:8080/basic-auth/u/p" }, ["http://10.0.0.1:8080"]],
    [
      "adds url-type custom fields after the url",
      {
        url: "https://a.example/",
        customFields: [{ label: "admin", type: "url", value: "http://b.example:81/x" }],
      },
      ["https://a.example", "http://b.example:81"],
    ],
    [
      "matches the custom field type case-insensitively",
      { customFields: [{ type: "URL", value: "https://c.example/" }] },
      ["https://c.example"],
    ],
    [
      "ignores custom fields of other types",
      {
        customFields: [
          { type: "text", value: "https://text.example/" },
          { type: "hidden", value: "https://hidden.example/" },
          { value: "https://untyped.example/" },
        ],
      },
      [],
    ],
    [
      "skips invalid and non-http(s) values",
      {
        url: "not a url",
        customFields: [
          { type: "url", value: "ftp://files.example/" },
          { type: "url", value: "javascript:alert(1)" },
          { type: "url", value: 42 },
          { type: "url" },
          { type: "url", value: "https://ok.example/" },
        ],
      },
      ["https://ok.example"],
    ],
    [
      "drops duplicate origins",
      {
        url: "https://dup.example/a",
        customFields: [{ type: "url", value: "https://DUP.example:443/b" }],
      },
      ["https://dup.example"],
    ],
    ["returns nothing for a null url and no custom fields", { url: null }, []],
    [
      "tolerates malformed customFields",
      { url: "https://x.example/", customFields: "nope" },
      ["https://x.example"],
    ],
    [
      "tolerates non-object custom field entries",
      { customFields: [null, "https://raw.example/", { type: "url", value: "https://y.example/" }] },
      ["https://y.example"],
    ],
  ])("%s", (_name, blob, expected) => {
    expect(savedUrlOrigins(blob)).toEqual(expected);
  });
});
