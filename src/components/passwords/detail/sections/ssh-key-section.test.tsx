// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

import { SshKeySection } from "./ssh-key-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  keyType: "ed25519",
  keySize: 256,
  fingerprint: "SHA256:abc123",
  publicKey: "ssh-ed25519 AAAA...",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPassphrase: "secret-pass",
  sshComment: "alice@laptop",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("SshKeySection", () => {
  it("renders keyType, keySize, fingerprint, and publicKey", () => {
    render(
      <SshKeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("ed25519")).toBeInTheDocument();
    expect(screen.getByText("256")).toBeInTheDocument();
    expect(screen.getByText("SHA256:abc123")).toBeInTheDocument();
    expect(screen.getByText("ssh-ed25519 AAAA...")).toBeInTheDocument();
  });

  it("masks the private key and passphrase by default", () => {
    render(
      <SshKeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(
      screen.queryByText("-----BEGIN OPENSSH PRIVATE KEY-----"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("secret-pass")).not.toBeInTheDocument();
    expect(screen.getAllByText("••••••••").length).toBeGreaterThan(0);
  });

  it("renders the comment", () => {
    render(
      <SshKeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("alice@laptop")).toBeInTheDocument();
  });
});
