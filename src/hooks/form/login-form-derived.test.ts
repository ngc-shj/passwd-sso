import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator/generator-prefs";
import type { GeneratorSettings } from "@/lib/generator/generator-prefs";
import { buildLoginFormDerived, buildSnapshot } from "@/hooks/form/login-form-derived";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function tGen(key: "modePassphrase" | "modePassword"): string {
  return key === "modePassword" ? "Password" : "Passphrase";
}

interface ValuesOverride {
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  tags?: Array<{ id?: string; name: string; color: string | null }>;
  customFields?: unknown[];
  totp?: unknown | null;
  folderId?: string | null;
  requireReprompt?: boolean;
  travelSafe?: boolean;
  expiresAt?: string | null;
  generatorSettings?: GeneratorSettings;
}

function buildValues(overrides: ValuesOverride = {}) {
  return {
    title: overrides.title ?? "My Title",
    username: overrides.username ?? "user",
    password: overrides.password ?? "pass",
    url: overrides.url ?? "https://example.com",
    notes: overrides.notes ?? "notes",
    tags: overrides.tags ?? [{ id: "t1", name: "work", color: null }],
    customFields: overrides.customFields ?? [],
    totp: overrides.totp !== undefined ? overrides.totp : null,
    folderId: overrides.folderId !== undefined ? overrides.folderId : "folder-1",
    requireReprompt: overrides.requireReprompt ?? false,
    travelSafe: overrides.travelSafe ?? true,
    expiresAt: overrides.expiresAt !== undefined ? overrides.expiresAt : null,
    generatorSettings: overrides.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
  };
}

/* ------------------------------------------------------------------ */
/*  buildSnapshot                                                      */
/* ------------------------------------------------------------------ */

describe("buildSnapshot", () => {
  describe("personal scope", () => {
    it("includes generatorSettings in the snapshot", () => {
      const values = buildValues();
      const snapshot = JSON.parse(buildSnapshot("personal", values));
      expect(snapshot.generatorSettings).toBeDefined();
      expect(snapshot.generatorSettings.mode).toBe("password");
    });

    it("includes tags as full objects", () => {
      const values = buildValues({
        tags: [{ id: "t1", name: "work", color: "#ff0000" }],
      });
      const snapshot = JSON.parse(buildSnapshot("personal", values));
      expect(snapshot.tags).toEqual([{ id: "t1", name: "work", color: "#ff0000" }]);
    });

    it("includes customFields and totp directly (not double-stringified)", () => {
      const values = buildValues({
        customFields: [{ label: "field1", value: "val1", type: "text" }],
        totp: { secret: "JBSWY3DPEHPK3PXP" },
      });
      const snapshot = JSON.parse(buildSnapshot("personal", values));
      expect(Array.isArray(snapshot.customFields)).toBe(true);
      expect(snapshot.customFields[0]).toEqual({ label: "field1", value: "val1", type: "text" });
      expect(snapshot.totp).toEqual({ secret: "JBSWY3DPEHPK3PXP" });
    });
  });

  describe("team scope", () => {
    it("excludes generatorSettings from the snapshot", () => {
      const values = buildValues();
      const snapshot = JSON.parse(buildSnapshot("team", values));
      expect(snapshot.generatorSettings).toBeUndefined();
    });

    it("represents tags as sorted IDs only", () => {
      const values = buildValues({
        tags: [
          { id: "t2", name: "beta", color: null },
          { id: "t1", name: "alpha", color: null },
        ],
      });
      const snapshot = JSON.parse(buildSnapshot("team", values));
      expect(snapshot.selectedTagIds).toEqual(["t1", "t2"]);
      expect(snapshot.tags).toBeUndefined();
    });

    it("double-stringifies customFields and totp for stability", () => {
      const values = buildValues({
        customFields: [{ label: "f", value: "v", type: "text" }],
        totp: { secret: "ABC" },
      });
      const snapshot = JSON.parse(buildSnapshot("team", values));
      // Both are JSON strings (double-stringified)
      expect(typeof snapshot.customFields).toBe("string");
      expect(typeof snapshot.totp).toBe("string");
      expect(JSON.parse(snapshot.customFields)).toEqual([{ label: "f", value: "v", type: "text" }]);
      expect(JSON.parse(snapshot.totp)).toEqual({ secret: "ABC" });
    });

    it("uses folderId as teamFolderId key", () => {
      const values = buildValues({ folderId: "folder-42" });
      const snapshot = JSON.parse(buildSnapshot("team", values));
      expect(snapshot.teamFolderId).toBe("folder-42");
      expect(snapshot.folderId).toBeUndefined();
    });
  });
});

/* ------------------------------------------------------------------ */
/*  buildLoginFormDerived — personal scope                            */
/* ------------------------------------------------------------------ */

describe("buildLoginFormDerived (personal scope)", () => {
  function buildArgs(current: ValuesOverride = {}, initial?: ValuesOverride) {
    const values = buildValues(current);
    const initialValues = buildValues(initial ?? current);
    return {
      scope: "personal" as const,
      ...values,
      tGen,
      initialSnapshot: buildSnapshot("personal", initialValues),
    };
  }

  it("returns hasChanges=false when values match initial snapshot", () => {
    const result = buildLoginFormDerived(buildArgs());
    expect(result.hasChanges).toBe(false);
  });

  it("detects title change", () => {
    const result = buildLoginFormDerived(buildArgs({ title: "Changed" }, { title: "Original" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects username change", () => {
    const result = buildLoginFormDerived(buildArgs({ username: "new-user" }, { username: "old-user" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects password change", () => {
    const result = buildLoginFormDerived(buildArgs({ password: "new-pass" }, { password: "old-pass" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects url change", () => {
    const result = buildLoginFormDerived(buildArgs({ url: "https://new.com" }, { url: "https://old.com" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects notes change", () => {
    const result = buildLoginFormDerived(buildArgs({ notes: "new notes" }, { notes: "old notes" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects folderId change", () => {
    const result = buildLoginFormDerived(buildArgs({ folderId: "f2" }, { folderId: "f1" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects travelSafe change", () => {
    const result = buildLoginFormDerived(buildArgs({ travelSafe: false }, { travelSafe: true }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects generatorSettings change", () => {
    const changedSettings = { ...DEFAULT_GENERATOR_SETTINGS, length: 32 };
    const result = buildLoginFormDerived(
      buildArgs({ generatorSettings: changedSettings }, {}),
    );
    expect(result.hasChanges).toBe(true);
  });

  it("detects tag change (deep equality comparison)", () => {
    const result = buildLoginFormDerived(
      buildArgs(
        { tags: [{ id: "t1", name: "work", color: "#ff0000" }] },
        { tags: [{ id: "t1", name: "work", color: null }] },
      ),
    );
    expect(result.hasChanges).toBe(true);
  });

  it("does NOT ignore tag order (compares full objects)", () => {
    const tag1 = { id: "t1", name: "a", color: null };
    const tag2 = { id: "t2", name: "b", color: null };
    const result = buildLoginFormDerived(
      buildArgs(
        { tags: [tag2, tag1] },
        { tags: [tag1, tag2] },
      ),
    );
    // personal scope uses JSON.stringify of full tag array, so order matters
    expect(result.hasChanges).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  buildLoginFormDerived — team scope                                */
/* ------------------------------------------------------------------ */

describe("buildLoginFormDerived (team scope)", () => {
  function buildArgs(current: ValuesOverride = {}, initial?: ValuesOverride) {
    const values = buildValues(current);
    const initialValues = buildValues(initial ?? current);
    return {
      scope: "team" as const,
      ...values,
      tGen,
      initialSnapshot: buildSnapshot("team", initialValues),
    };
  }

  it("returns hasChanges=false when values match initial snapshot", () => {
    const result = buildLoginFormDerived(buildArgs());
    expect(result.hasChanges).toBe(false);
  });

  it("detects title change", () => {
    const result = buildLoginFormDerived(buildArgs({ title: "New" }, { title: "Old" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects notes change", () => {
    const result = buildLoginFormDerived(buildArgs({ notes: "updated" }, { notes: "original" }));
    expect(result.hasChanges).toBe(true);
  });

  it("detects customFields change", () => {
    const result = buildLoginFormDerived(
      buildArgs(
        { customFields: [{ label: "l", value: "v", type: "text" }] },
        { customFields: [] },
      ),
    );
    expect(result.hasChanges).toBe(true);
  });

  it("detects totp change", () => {
    const result = buildLoginFormDerived(
      buildArgs({ totp: { secret: "SECRET" } }, { totp: null }),
    );
    expect(result.hasChanges).toBe(true);
  });

  it("detects tag addition", () => {
    const result = buildLoginFormDerived(
      buildArgs(
        { tags: [{ id: "t1", name: "a", color: null }, { id: "t2", name: "b", color: null }] },
        { tags: [{ id: "t1", name: "a", color: null }] },
      ),
    );
    expect(result.hasChanges).toBe(true);
  });

  it("ignores tag order (compares sorted IDs)", () => {
    const tag1 = { id: "t1", name: "a", color: null };
    const tag2 = { id: "t2", name: "b", color: null };
    const result = buildLoginFormDerived(
      buildArgs(
        { tags: [tag2, tag1] },
        { tags: [tag1, tag2] },
      ),
    );
    expect(result.hasChanges).toBe(false);
  });

  it("generatorSettings change does NOT affect hasChanges", () => {
    const changedSettings = { ...DEFAULT_GENERATOR_SETTINGS, length: 32 };
    const result = buildLoginFormDerived(
      buildArgs({ generatorSettings: changedSettings }, {}),
    );
    // team snapshot excludes generatorSettings, so this must not trigger a change
    expect(result.hasChanges).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  generatorSummary                                                   */
/* ------------------------------------------------------------------ */

describe("generatorSummary", () => {
  const baseValues = buildValues();
  const initialSnapshot = buildSnapshot("personal", baseValues);

  it("builds password mode summary with length", () => {
    const result = buildLoginFormDerived({
      scope: "personal",
      ...baseValues,
      tGen,
      initialSnapshot,
    });
    expect(result.generatorSummary).toBe("Password \u00b7 20");
  });

  it("builds passphrase mode summary with word count", () => {
    const settings: GeneratorSettings = {
      ...DEFAULT_GENERATOR_SETTINGS,
      mode: "passphrase",
      passphrase: {
        ...DEFAULT_GENERATOR_SETTINGS.passphrase,
        wordCount: 5,
      },
    };
    const values = buildValues({ generatorSettings: settings });
    const result = buildLoginFormDerived({
      scope: "personal",
      ...values,
      tGen,
      initialSnapshot: buildSnapshot("personal", values),
    });
    expect(result.generatorSummary).toBe("Passphrase \u00b7 5");
  });

  it("uses tGen callback for labels", () => {
    const customTGen = (key: "modePassphrase" | "modePassword") =>
      key === "modePassword" ? "PW" : "PP";
    const result = buildLoginFormDerived({
      scope: "team",
      ...baseValues,
      tGen: customTGen,
      initialSnapshot: buildSnapshot("team", baseValues),
    });
    expect(result.generatorSummary).toBe("PW \u00b7 20");
  });

  it("produces the same summary regardless of scope", () => {
    const personalResult = buildLoginFormDerived({
      scope: "personal",
      ...baseValues,
      tGen,
      initialSnapshot,
    });
    const teamResult = buildLoginFormDerived({
      scope: "team",
      ...baseValues,
      tGen,
      initialSnapshot: buildSnapshot("team", baseValues),
    });
    expect(personalResult.generatorSummary).toBe(teamResult.generatorSummary);
  });
});
