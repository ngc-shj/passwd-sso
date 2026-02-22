import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;

function readNamespace(locale: string, namespace: string): JsonRecord {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, `${namespace}.json`),
      "utf8",
    ),
  ) as JsonRecord;
}

function expectNamespaceKeys(
  locale: string,
  namespace: string,
  keys: string[],
): void {
  const dict = readNamespace(locale, namespace);
  for (const key of keys) {
    expect(dict[key]).toBeTypeOf("string");
  }
}

describe("entry form i18n keys", () => {
  it("has required translation keys in ja/en", () => {

    const required: Record<string, string[]> = {
      Common: ["save", "update", "cancel", "back"],
      PasswordGenerator: ["modePassphrase", "modePassword"],
      PasswordForm: [
        "notes",
        "notesPlaceholder",
        "tagsHint",
        "statusUnsaved",
        "statusSaved",
      ],
      SecureNoteForm: [
        "newNote",
        "editNote",
        "title",
        "content",
        "tags",
        "notes",
        "notesPlaceholder",
        "saved",
        "updated",
        "failedToSave",
        "networkError",
      ],
      CreditCardForm: ["notes", "notesPlaceholder"],
      IdentityForm: ["notes", "notesPlaceholder"],
      PasskeyForm: ["notes", "notesPlaceholder"],
    };

    for (const [namespace, keys] of Object.entries(required)) {
      expectNamespaceKeys("ja", namespace, keys);
      expectNamespaceKeys("en", namespace, keys);
    }
  });
});
