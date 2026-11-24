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

  it("ignores edits to the private key while it is masked", () => {
    const onPrivateKeyChange = vi.fn();
    render(<SshKeyFields {...baseProps} privateKey="k" onPrivateKeyChange={onPrivateKeyChange} />);
    fireEvent.change(screen.getByLabelText("Private key"), { target: { value: "typed" } });
    expect(onPrivateKeyChange).not.toHaveBeenCalled();
  });

  it("reveals an empty masked private key on focus so it can be pasted into", () => {
    const onTogglePrivateKey = vi.fn();
    render(<SshKeyFields {...baseProps} onTogglePrivateKey={onTogglePrivateKey} />);
    fireEvent.focus(screen.getByLabelText("Private key"));
    expect(onTogglePrivateKey).toHaveBeenCalledTimes(1);
  });

  it("keeps a filled private key masked on focus", () => {
    const onTogglePrivateKey = vi.fn();
    render(
      <SshKeyFields {...baseProps} privateKey="k" onTogglePrivateKey={onTogglePrivateKey} />,
    );
    fireEvent.focus(screen.getByLabelText("Private key"));
    expect(onTogglePrivateKey).not.toHaveBeenCalled();
  });

  it("toggles the private key from the Show button", () => {
    const onTogglePrivateKey = vi.fn();
    render(<SshKeyFields {...baseProps} onTogglePrivateKey={onTogglePrivateKey} />);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(onTogglePrivateKey).toHaveBeenCalledTimes(1);
  });

  it("falls back to English Show/Hide text when the labels omit them", () => {
    const labels = { ...baseProps.labels, show: undefined, hide: undefined };
    const { rerender } = render(<SshKeyFields {...baseProps} labels={labels} />);
    expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
    rerender(<SshKeyFields {...baseProps} labels={labels} showPrivateKey />);
    expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();
  });

  it("calls onPrivateKeyBlur when the private key loses focus", () => {
    const onPrivateKeyBlur = vi.fn();
    render(<SshKeyFields {...baseProps} onPrivateKeyBlur={onPrivateKeyBlur} />);
    fireEvent.blur(screen.getByLabelText("Private key"));
    expect(onPrivateKeyBlur).toHaveBeenCalledTimes(1);
  });

  it("omits the key size suffix when keySize is 0", () => {
    render(<SshKeyFields {...baseProps} keyType="ed25519" fingerprint="SHA256:x" />);
    expect(screen.getByDisplayValue("ED25519")).toBeInTheDocument();
  });

  it("marks the public key as auto-detected only when a public key is present", () => {
    const { rerender } = render(
      <SshKeyFields {...baseProps} autoDetectedLabel="auto-detected" />,
    );
    expect(screen.queryByText("(auto-detected)")).not.toBeInTheDocument();
    rerender(
      <SshKeyFields {...baseProps} publicKey="ssh-ed25519 AAAA" autoDetectedLabel="auto-detected" />,
    );
    expect(screen.getByText("(auto-detected)")).toBeInTheDocument();
  });

  it.each([
    ["PubPH", "onPublicKeyChange", "ssh-ed25519 AAAA"],
    ["PassPH", "onPassphraseChange", "secret"],
    ["CommentPH", "onCommentChange", "laptop"],
    ["NotesPH", "onNotesChange", "memo"],
  ] as const)("routes typing in the %s input to %s", (placeholder, handler, value) => {
    const fn = vi.fn();
    render(<SshKeyFields {...baseProps} {...{ [handler]: fn }} />);
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
    expect(fn).toHaveBeenCalledWith(value);
  });
});
