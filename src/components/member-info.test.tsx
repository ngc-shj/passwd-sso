// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="avatar" className={className}>{children}</div>
  ),
  AvatarImage: ({ src }: { src?: string }) => (
    src ? <span data-testid="avatar-image" data-src={src} /> : null
  ),
  AvatarFallback: ({ children }: { children: ReactNode }) => (
    <span data-testid="avatar-fallback">{children}</span>
  ),
}));

vi.mock("lucide-react", () => ({
  Globe: () => <span data-testid="globe-icon" />,
}));

import { MemberInfo } from "./member-info";

function renderMemberInfo(props: Parameters<typeof MemberInfo>[0]) {
  return render(
    <div data-testid="wrapper">
      <MemberInfo {...props} />
    </div>
  );
}

describe("MemberInfo", () => {
  it("displays name and email when both present", () => {
    renderMemberInfo({ name: "Alice", email: "alice@example.com", image: null });

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  });

  it("displays email as primary text when name is null", () => {
    renderMemberInfo({ name: null, email: "bob@example.com", image: null });

    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    // Email should not appear twice (once as primary, once as secondary)
    expect(screen.getAllByText("bob@example.com")).toHaveLength(1);
  });

  it("displays name without email line when email is null", () => {
    renderMemberInfo({ name: "Charlie", email: null, image: null });

    expect(screen.getByText("Charlie")).toBeInTheDocument();
    // Only one text element should be in the name area (no secondary email line)
    const texts = screen.getByTestId("wrapper").querySelectorAll(".text-xs.text-muted-foreground");
    expect(texts).toHaveLength(0);
  });

  it("shows fallback '?' when both name and email are null", () => {
    renderMemberInfo({ name: null, email: null, image: null });

    expect(screen.getByTestId("avatar-fallback")).toHaveTextContent("?");
  });

  it("shows avatar fallback with first char of name", () => {
    renderMemberInfo({ name: "Diana", email: "diana@example.com", image: null });

    expect(screen.getByTestId("avatar-fallback")).toHaveTextContent("D");
  });

  it("shows avatar fallback with first char of email when name is null", () => {
    renderMemberInfo({ name: null, email: "eve@example.com", image: null });

    expect(screen.getByTestId("avatar-fallback")).toHaveTextContent("E");
  });

  it("passes image src to AvatarImage", () => {
    renderMemberInfo({ name: "Test", email: null, image: "https://example.com/photo.jpg" });

    expect(screen.getByTestId("avatar-image")).toHaveAttribute("data-src", "https://example.com/photo.jpg");
  });

  it("shows '(you)' label when isCurrentUser is true", () => {
    renderMemberInfo({ name: "Me", email: "me@example.com", image: null, isCurrentUser: true });

    // useTranslations mock returns the key itself
    expect(screen.getByText("you")).toBeInTheDocument();
  });

  it("does not show '(you)' label when isCurrentUser is false", () => {
    renderMemberInfo({ name: "Other", email: "other@example.com", image: null, isCurrentUser: false });

    expect(screen.queryByText("you")).not.toBeInTheDocument();
  });

  it("renders nameExtra inline with name", () => {
    renderMemberInfo({
      name: "Admin",
      email: "admin@example.com",
      image: null,
      nameExtra: <span data-testid="role-badge">Owner</span>,
    });

    expect(screen.getByTestId("role-badge")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("renders children below name/email", () => {
    renderMemberInfo({
      name: "User",
      email: "user@example.com",
      image: null,
      children: <span data-testid="child-content">Extra</span>,
    });

    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("shows tenant badge when tenantName differs from teamTenantName", () => {
    renderMemberInfo({
      name: "External",
      email: "ext@example.com",
      image: null,
      tenantName: "Other Org",
      teamTenantName: "My Org",
    });

    expect(screen.getByTestId("globe-icon")).toBeInTheDocument();
    expect(screen.getByText("Other Org")).toBeInTheDocument();
  });

  it("does not show tenant badge when tenantName equals teamTenantName", () => {
    renderMemberInfo({
      name: "Internal",
      email: "int@example.com",
      image: null,
      tenantName: "Same Org",
      teamTenantName: "Same Org",
    });

    expect(screen.queryByTestId("globe-icon")).not.toBeInTheDocument();
  });

  it("does not show tenant badge when teamTenantName is null", () => {
    renderMemberInfo({
      name: "User",
      email: "user@example.com",
      image: null,
      tenantName: "Some Org",
      teamTenantName: null,
    });

    expect(screen.queryByTestId("globe-icon")).not.toBeInTheDocument();
  });

  it("does not render avatar image when image is null", () => {
    renderMemberInfo({ name: "Test", email: null, image: null });

    expect(screen.queryByTestId("avatar-image")).not.toBeInTheDocument();
  });
});
