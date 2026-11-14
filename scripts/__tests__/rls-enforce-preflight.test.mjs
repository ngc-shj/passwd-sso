/**
 * DB-free tests for the flip preflight decision in scripts/rls-enforce-preflight.mjs.
 */
import { describe, it, expect } from "vitest";
import { decideFlipPreflight, FLIP_MIGRATION, ATTESTATION_ENV } from "../rls-enforce-preflight.mjs";

const DONE = new Date("2026-11-01T00:00:00Z");
const row = (migration_name, finished_at = DONE, rolled_back_at = null) => ({
  migration_name,
  finished_at,
  rolled_back_at,
});
const OTHER = row("20260101000000_init");
const decide = (rows, attestation) => decideFlipPreflight({ tableExists: true, rows, attestation });

describe("decideFlipPreflight", () => {
  it("passes a database with no migration table", () => {
    expect(decideFlipPreflight({ tableExists: false, rows: [], attestation: undefined }).ok).toBe(true);
  });

  it("passes a database whose migration table is empty", () => {
    expect(decide([], undefined).ok).toBe(true);
  });

  it("passes when the flip migration is applied, without an attestation", () => {
    expect(decide([OTHER, row(FLIP_MIGRATION)], undefined).ok).toBe(true);
  });

  it("refuses a pending flip with no attestation", () => {
    expect(decide([OTHER], undefined).ok).toBe(false);
  });

  it("refuses a pending flip with a wrong attestation value", () => {
    expect(decide([OTHER], "true").ok).toBe(false);
  });

  it("refuses a pending flip with an empty attestation", () => {
    expect(decide([OTHER], "").ok).toBe(false);
  });

  it("passes a pending flip with the exact attestation", () => {
    expect(decide([OTHER], FLIP_MIGRATION).ok).toBe(true);
  });

  it("refuses a failed flip row without the attestation", () => {
    expect(decide([OTHER, row(FLIP_MIGRATION, null)], undefined).ok).toBe(false);
  });

  it("passes a failed flip row with the attestation", () => {
    expect(decide([OTHER, row(FLIP_MIGRATION, null)], FLIP_MIGRATION).ok).toBe(true);
  });

  it("refuses a rolled-back flip row without the attestation", () => {
    expect(decide([OTHER, row(FLIP_MIGRATION, DONE, DONE)], undefined).ok).toBe(false);
  });

  it("passes a rolled-back flip row with the attestation", () => {
    expect(decide([OTHER, row(FLIP_MIGRATION, DONE, DONE)], FLIP_MIGRATION).ok).toBe(true);
  });

  it("refuses a database that has migrations but not the report-mode one", () => {
    expect(decide([row("20250101000000_older")], undefined).ok).toBe(false);
  });

  it("names the variable, the value to set and the deployment doc when refusing", () => {
    const { reason } = decide([OTHER], undefined);
    expect(reason).toContain(ATTESTATION_ENV);
    expect(reason).toContain(FLIP_MIGRATION);
    expect(reason).toContain("docs/operations/deployment.md");
  });
});
