import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import * as departureRead from "./tenant-departure-read";
import * as rowLock from "./tenant-row-lock";

// The audit-outbox worker bundle (CJS) loads this module: a value import that
// reaches @/lib/prisma pulls the Prisma runtime and a database connection into it.
describe("tenant-departure-read import safety", () => {
  const source = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true })
    .addSourceFileAtPath(new URL("./tenant-departure-read.ts", import.meta.url).pathname);
  const imports = source.getImportDeclarations();

  it("declares at least one import, so the loop below is not vacuous", () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  it("has only type-only imports", () => {
    for (const decl of imports) {
      const named = decl.getNamedImports();
      const typeOnly = decl.isTypeOnly() || (named.length > 0 && named.every((n) => n.isTypeOnly()));
      expect(typeOnly, decl.getText()).toBe(true);
      expect(decl.getDefaultImport(), decl.getText()).toBeUndefined();
      expect(decl.getNamespaceImport(), decl.getText()).toBeUndefined();
    }
  });

  it("imports nothing but @prisma/client", () => {
    expect(imports.map((decl) => decl.getModuleSpecifierValue())).toEqual(["@prisma/client"]);
  });

  it("has no re-exports from another module", () => {
    expect(source.getExportDeclarations().filter((decl) => decl.hasModuleSpecifier())).toEqual([]);
  });
});

describe("tenant-row-lock re-exports", () => {
  it.each(["readTenantRows", "departedAt", "departedSince", "actorDepartedSinceAdmission"] as const)(
    "re-exports %s as the same function",
    (name) => {
      expect(rowLock[name]).toBe(departureRead[name]);
    },
  );
});
