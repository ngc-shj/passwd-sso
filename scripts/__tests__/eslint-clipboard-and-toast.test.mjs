// Pins the clipboard, toast and copySecretWithoutClear restrictions through the
// real eslint.config.mjs. Each block that sets no-restricted-syntax REPLACES the
// earlier blocks' options for the files it matches, so every selector is tested
// on a fixture path of every block — and INSENSITIVE_EQUALS is re-checked on each
// one, since a block that forgot to restate it would silently drop it.
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

const PRELUDE = [
  'import { toast } from "sonner";',
  "declare const t: (key: string) => string;",
  "declare const m: string | undefined;",
  "declare const c: boolean;",
  "declare const v: string;",
  "declare const e: ClipboardEvent;",
  "",
].join("\n");

async function messages(code, filePath) {
  const [result] = await eslint.lintText(PRELUDE + code, { filePath });
  return result.messages;
}

async function hits(code, filePath, ruleId, fragment) {
  return (await messages(code, filePath)).filter(
    (msg) => msg.ruleId === ruleId && msg.message.includes(fragment),
  ).length;
}

const clipboardHits = (code, filePath) =>
  hits(code, filePath, "no-restricted-syntax", "copySecretToClipboard");
const toastHits = (code, filePath) =>
  hits(code, filePath, "no-restricted-syntax", "Toast text must be translated");
const insensitiveHits = (code, filePath) =>
  hits(code, filePath, "no-restricted-syntax", "unescaped ILIKE");
const fetchHits = (code, filePath) =>
  hits(code, filePath, "no-restricted-syntax", "fetchApi()");
const withoutClearHits = (code, filePath) =>
  hits(code, filePath, "no-restricted-imports", "copySecretWithoutClear");
const dynamicCopySecretHits = (code, filePath) =>
  hits(code, filePath, "no-restricted-syntax", "Import @/lib/clipboard/copy-secret statically");

const FIXTURES = [
  "src/lib/x.ts",
  "src/app/x/page.tsx",
  "src/components/x.tsx",
  "src/hooks/x.ts",
  "proxy.ts",
  "instrumentation-client.ts",
  "sentry.server.config.ts",
];

// One snippet per selector, each matching that selector alone.
const CLIPBOARD_WRITES = [
  ["navigator.clipboard", "export const p = navigator.clipboard.writeText(v);"],
  ["navigator['clipboard']", 'export const p = navigator["clipboard"].writeText(v);'],
  ["a destructured clipboard", "const { clipboard } = navigator;\nexport const p = clipboard;"],
  ["a quoted destructured clipboard", 'const { "clipboard": cb } = navigator;\nexport const p = cb;'],
  ["execCommand", 'export const p = document.execCommand("copy");'],
  ["clipboardData.setData", 'e.clipboardData.setData("text/plain", v);'],
];

const TOAST_LITERALS = [
  ["a direct literal", 'toast.error("failed");'],
  ["a template literal", "toast.success(`done ${v}`);"],
  ["a ?? arm", 'toast.error(m ?? "failed");'],
  ["a || arm", 'toast.error(m || "failed");'],
  ["a ternary consequent", 'toast.error(c ? "failed" : t("k"));'],
  ["a ternary alternate", 'toast.error(c ? t("k") : "failed");'],
  ["a bare toast()", 'toast("failed");'],
];

const INSENSITIVE_EQUALS = 'export const w = { email: { equals: "a", mode: "insensitive" } };';

describe("clipboard writes are restricted to src/lib/clipboard", () => {
  for (const filePath of FIXTURES) {
    it.each(CLIPBOARD_WRITES)(`reports %s in ${filePath}`, async (_label, code) => {
      expect(await clipboardHits(code, filePath)).toBeGreaterThanOrEqual(1);
    });
  }

  it("reports each clipboard selector exactly once on its own snippet", async () => {
    const counts = await Promise.all(
      CLIPBOARD_WRITES.map(([, code]) => clipboardHits(code, "src/components/x.tsx")),
    );
    expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("does not report in copy-secret.ts, the one sanctioned writer", async () => {
    expect(await clipboardHits(CLIPBOARD_WRITES[0][1], "src/lib/clipboard/copy-secret.ts")).toBe(0);
  });

  it.each(["src/lib/clipboard/x.ts", "src/lib/clipboard/report-copy-outcome.ts"])(
    "reports in %s, which shares the directory but not the exemption",
    async (filePath) => {
      expect(await clipboardHits(CLIPBOARD_WRITES[0][1], filePath)).toBe(1);
    },
  );

  it("reports an untranslated toast in src/lib/clipboard outside copy-secret.ts", async () => {
    expect(await toastHits(TOAST_LITERALS[0][1], "src/lib/clipboard/report-copy-outcome.ts")).toBe(1);
  });

  it("does not report in a test file", async () => {
    expect(await clipboardHits(CLIPBOARD_WRITES[0][1], "src/components/x.test.tsx")).toBe(0);
  });

  it("does not report reading pasted text with clipboardData.getData", async () => {
    const code = 'export const pasted = e.clipboardData?.getData("text");';
    expect(await clipboardHits(code, "src/components/x.tsx")).toBe(0);
  });
});

describe("toast text must be translated", () => {
  for (const filePath of FIXTURES) {
    it.each(TOAST_LITERALS)(`reports %s in ${filePath}`, async (_label, code) => {
      expect(await toastHits(code, filePath)).toBe(1);
    });
  }

  it.each([
    ["a translated message", 'toast.error(t("k"));'],
    ["translated ternary arms", 'toast.error(c ? t("a") : t("b"));'],
    ["a translated ?? fallback", 'toast.error(m ?? t("k"));'],
  ])("does not report %s", async (_label, code) => {
    expect(await toastHits(code, "src/components/x.tsx")).toBe(0);
  });
});

describe("copySecretWithoutClear is restricted by import", () => {
  const COMPONENT = "src/components/vault/x.tsx";

  it.each([
    ["a named import", 'import { copySecretWithoutClear } from "@/lib/clipboard/copy-secret";\nexport const f = copySecretWithoutClear;'],
    ["an aliased import", 'import { copySecretWithoutClear as c2 } from "@/lib/clipboard/copy-secret";\nexport const f = c2;'],
    ["a namespace import", 'import * as cs from "@/lib/clipboard/copy-secret";\nexport const f = cs.copySecretWithoutClear;'],
    ["a relative import", 'import { copySecretWithoutClear } from "../../lib/clipboard/copy-secret";\nexport const f = copySecretWithoutClear;'],
    ["use by reference", 'import { copySecretWithoutClear } from "@/lib/clipboard/copy-secret";\nexport const run = () => copySecretWithoutClear(() => v);'],
  ])("reports %s", async (_label, code) => {
    expect(await withoutClearHits(code, COMPONENT)).toBe(1);
  });

  it("does not report importing copySecretToClipboard from the same module", async () => {
    const code = 'import { copySecretToClipboard } from "@/lib/clipboard/copy-secret";\nexport const f = copySecretToClipboard;';
    expect(await withoutClearHits(code, COMPONENT)).toBe(0);
  });

  describe("a dynamic import() or require() of the module", () => {
    const DYNAMIC_FORMS = [
      ["an @/-aliased dynamic import()", 'export const m = import("@/lib/clipboard/copy-secret");'],
      ["a relative dynamic import()", 'export const m = import("../../lib/clipboard/copy-secret");'],
      ["a static template-literal import()", "export const m = import(`@/lib/clipboard/copy-secret`);"],
      ["a require()", 'export const m = require("@/lib/clipboard/copy-secret");'],
    ];

    for (const filePath of FIXTURES) {
      it.each(DYNAMIC_FORMS)(`reports %s in ${filePath}`, async (_label, code) => {
        expect(await dynamicCopySecretHits(code, filePath)).toBe(1);
      });
    }

    it("reports it in the sanctioned non-clearing caller too", async () => {
      const code = DYNAMIC_FORMS[0][1];
      expect(await dynamicCopySecretHits(code, "src/components/vault/recovery-key-dialog.tsx")).toBe(1);
    });

    it.each([
      ["a dynamic import() of another clipboard module", 'export const m = import("@/lib/clipboard/report-copy-outcome");'],
      ["a dynamic import() of an unrelated module", 'export const m = import("@/lib/url-helpers");'],
      ["a static import of the module", 'import { copySecretToClipboard } from "@/lib/clipboard/copy-secret";\nexport const f = copySecretToClipboard;'],
    ])("does not report %s", async (_label, code) => {
      expect(await dynamicCopySecretHits(code, COMPONENT)).toBe(0);
    });

    it("does not report in a test file", async () => {
      expect(await dynamicCopySecretHits(DYNAMIC_FORMS[0][1], "src/components/x.test.tsx")).toBe(0);
    });
  });

  describe("the sanctioned caller, recovery-key-dialog.tsx", () => {
    const RECOVERY = "src/components/vault/recovery-key-dialog.tsx";

    it("may import copySecretWithoutClear", async () => {
      const code = 'import { copySecretWithoutClear } from "@/lib/clipboard/copy-secret";\nexport const f = copySecretWithoutClear;';
      expect(await withoutClearHits(code, RECOVERY)).toBe(0);
    });

    it("still may not write to the clipboard directly", async () => {
      expect(await clipboardHits(CLIPBOARD_WRITES[0][1], RECOVERY)).toBe(1);
    });

    it("still may not call plain fetch()", async () => {
      expect(await fetchHits('export const p = fetch("/api/x");', RECOVERY)).toBe(1);
    });
  });
});

describe("the restrictions each block already carried survive", () => {
  it("still reports plain fetch() in a component", async () => {
    expect(await fetchHits('export const p = fetch("/api/x");', "src/components/x.tsx")).toBe(1);
  });

  it.each([
    ...FIXTURES,
    "src/components/x.test.tsx",
    "src/lib/clipboard/x.ts",
    "scripts/x.ts",
  ])("still reports insensitive equals in %s", async (filePath) => {
    expect(await insensitiveHits(INSENSITIVE_EQUALS, filePath)).toBe(1);
  });
});
