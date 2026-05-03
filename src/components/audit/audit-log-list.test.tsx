// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AuditLogItem } from "@/hooks/vault/use-audit-logs";
import { AuditLogList } from "./audit-log-list";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

function makeLog(id: string): AuditLogItem {
  return {
    id,
    action: "AUTH_LOGIN",
    createdAt: "2025-01-01T00:00:00Z",
    userId: "u1",
  } as unknown as AuditLogItem;
}

describe("AuditLogList", () => {
  it("renders a loading spinner when loading=true (no rows, no empty state)", () => {
    const { container } = render(
      <AuditLogList
        logs={[]}
        loading={true}
        loadingMore={false}
        nextCursor={null}
        onLoadMore={vi.fn()}
        renderItem={() => null}
      />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("noLogs")).toBeNull();
  });

  it("renders the noLogs message when logs is empty and not loading", () => {
    render(
      <AuditLogList
        logs={[]}
        loading={false}
        loadingMore={false}
        nextCursor={null}
        onLoadMore={vi.fn()}
        renderItem={() => null}
      />,
    );
    expect(screen.getByText("noLogs")).toBeInTheDocument();
  });

  it("invokes renderItem for each log entry", () => {
    const renderItem = vi.fn((log: AuditLogItem) => (
      <div key={log.id} data-testid={`log-${log.id}`}>{log.id}</div>
    ));
    render(
      <AuditLogList
        logs={[makeLog("a"), makeLog("b")]}
        loading={false}
        loadingMore={false}
        nextCursor={null}
        onLoadMore={vi.fn()}
        renderItem={renderItem}
      />,
    );
    expect(renderItem).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("log-a")).toBeInTheDocument();
    expect(screen.getByTestId("log-b")).toBeInTheDocument();
  });

  it("renders Load more button when nextCursor is set and triggers onLoadMore", () => {
    const onLoadMore = vi.fn();
    render(
      <AuditLogList
        logs={[makeLog("a")]}
        loading={false}
        loadingMore={false}
        nextCursor="cursor-1"
        onLoadMore={onLoadMore}
        renderItem={(log) => <div key={log.id}>{log.id}</div>}
      />,
    );
    const btn = screen.getByRole("button", { name: "loadMore" });
    fireEvent.click(btn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("disables Load more button while loadingMore (R26 disabled cue)", () => {
    render(
      <AuditLogList
        logs={[makeLog("a")]}
        loading={false}
        loadingMore={true}
        nextCursor="cursor-1"
        onLoadMore={vi.fn()}
        renderItem={(log) => <div key={log.id}>{log.id}</div>}
      />,
    );
    expect(screen.getByRole("button", { name: /loadMore/ })).toBeDisabled();
  });

  it("does NOT render Load more button when nextCursor is null", () => {
    render(
      <AuditLogList
        logs={[makeLog("a")]}
        loading={false}
        loadingMore={false}
        nextCursor={null}
        onLoadMore={vi.fn()}
        renderItem={(log) => <div key={log.id}>{log.id}</div>}
      />,
    );
    expect(screen.queryByRole("button", { name: /loadMore/ })).toBeNull();
  });
});
