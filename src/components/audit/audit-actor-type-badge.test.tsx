// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { AuditActorTypeBadge } from "./audit-actor-type-badge";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("AuditActorTypeBadge", () => {
  it("returns null for HUMAN with no sentinel userId (no badge)", () => {
    const { container } = render(<AuditActorTypeBadge actorType="HUMAN" />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when actorType is missing and no sentinel userId", () => {
    const { container } = render(<AuditActorTypeBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the anonymous i18n key for the ANONYMOUS sentinel userId", () => {
    render(<AuditActorTypeBadge userId={ANONYMOUS_ACTOR_ID} />);
    expect(screen.getByText("actorTypeAnonymous")).toBeInTheDocument();
  });

  it("renders the system i18n key for the SYSTEM sentinel userId", () => {
    render(<AuditActorTypeBadge userId={SYSTEM_ACTOR_ID} />);
    expect(screen.getByText("actorTypeSystem")).toBeInTheDocument();
  });

  it("renders SERVICE_ACCOUNT label for actorType SERVICE_ACCOUNT", () => {
    render(<AuditActorTypeBadge actorType="SERVICE_ACCOUNT" />);
    expect(screen.getByText("actorTypeSa")).toBeInTheDocument();
  });

  it("renders MCP_AGENT label for actorType MCP_AGENT", () => {
    render(<AuditActorTypeBadge actorType="MCP_AGENT" />);
    expect(screen.getByText("actorTypeMcp")).toBeInTheDocument();
  });

  it("falls back to the raw actorType string for unknown non-HUMAN values", () => {
    render(<AuditActorTypeBadge actorType="WEIRD_TYPE" />);
    expect(screen.getByText("WEIRD_TYPE")).toBeInTheDocument();
  });

  it("sentinel userId takes precedence over actorType", () => {
    // Even when actorType is set, a sentinel userId wins.
    render(<AuditActorTypeBadge actorType="SERVICE_ACCOUNT" userId={SYSTEM_ACTOR_ID} />);
    expect(screen.getByText("actorTypeSystem")).toBeInTheDocument();
    expect(screen.queryByText("actorTypeSa")).toBeNull();
  });
});
