// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SshKeyFields } from "./ssh-key-fields";

const baseProps = {
  privateKey: "",
  onPrivateKeyChange: vi.fn(),
  privateKeyPlaceholder: "PrivPH",
  showPrivateKey: false,
  onTogglePrivateKey: vi.fn(),
  publicKey: "",
  onPublicKeyChange: vi.fn(),
  publicKeyPlaceholder: "PubPH",
  keyType: "",
  fingerprint: "",
  keySize: 0,
  passphrase: "",
  onPassphraseChange: vi.fn(),
  passphrasePlaceholder: "PassPH",
  showPassphrase: false,
  onTogglePassphrase: vi.fn(),
  comment: "",
  onCommentChange: vi.fn(),
  commentPlaceholder: "CommentPH",
  notesLabel: "Notes",
  notes: "",
  onNotesChange: vi.fn(),
  notesPlaceholder: "NotesPH",
  labels: {
    privateKey: "Private key",
    publicKey: "Public key",
    keyType: "Key type",
    keySize: "Key size",
    fingerprint: "Fingerprint",
    passphrase: "Passphrase",
    comment: "Comment",
    show: "Show",
    hide: "Hide",
  },
};

describe("SshKeyFields", () => {
  it("renders mask placeholder for the private key when not shown but value is set", () => {
    const { container } = render(
      <SshKeyFields {...baseProps} privateKey="-----BEGIN RSA-----" showPrivateKey={false} />,
    );
    const ta = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    expect(ta.value).toBe("••••••••");
    expect(ta.readOnly).toBe(true);
  });

  it("shows the private key value when showPrivateKey=true and accepts edits", () => {
    const onPrivateKeyChange = vi.fn();
    const { container } = render(
      <SshKeyFields
        {...baseProps}
        privateKey="-----PRIV-----"
        showPrivateKey={true}
        onPrivateKeyChange={onPrivateKeyChange}
      />,
    );
    const ta = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    expect(ta.value).toBe("-----PRIV-----");
    expect(ta.readOnly).toBe(false);
    fireEvent.change(ta, { target: { value: "new" } });
    expect(onPrivateKeyChange).toHaveBeenCalledWith("new");
  });

  it("renders Show / Hide button per labels prop", () => {
    const { rerender } = render(<SshKeyFields {...baseProps} showPrivateKey={false} />);
    expect(screen.getByText("Show")).toBeInTheDocument();
    rerender(<SshKeyFields {...baseProps} showPrivateKey={true} />);
    expect(screen.getByText("Hide")).toBeInTheDocument();
  });

  it("renders keyType + keySize panel only when keyType or fingerprint is set", () => {
    const { rerender, container } = render(
      <SshKeyFields {...baseProps} keyType="" fingerprint="" />,
    );
    expect(screen.queryByText("Key type")).toBeNull();
    rerender(
      <SshKeyFields {...baseProps} keyType="rsa" keySize={2048} fingerprint="SHA256:abcd" />,
    );
    expect(screen.getByText("Key type")).toBeInTheDocument();
    // KeyType label includes the bit string
    const inputs = container.querySelectorAll("input[readonly]");
    const ktVal = (inputs[0] as HTMLInputElement).value;
    expect(ktVal).toContain("RSA");
    expect(ktVal).toContain("2048");
  });

  it("renders privateKeyWarning when supplied", () => {
    render(<SshKeyFields {...baseProps} privateKeyWarning="Long form detected" />);
    expect(screen.getByText("Long form detected")).toBeInTheDocument();
  });
});
