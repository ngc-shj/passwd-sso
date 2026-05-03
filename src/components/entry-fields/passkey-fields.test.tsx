// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PasskeyFields } from "./passkey-fields";

const baseProps = {
  relyingPartyId: "",
  onRelyingPartyIdChange: vi.fn(),
  relyingPartyIdPlaceholder: "RpIdPH",
  relyingPartyName: "",
  onRelyingPartyNameChange: vi.fn(),
  relyingPartyNamePlaceholder: "RpNamePH",
  username: "",
  onUsernameChange: vi.fn(),
  usernamePlaceholder: "UserPH",
  credentialId: "",
  onCredentialIdChange: vi.fn(),
  credentialIdPlaceholder: "CredPH",
  showCredentialId: false,
  onToggleCredentialId: vi.fn(),
  creationDate: "",
  onCreationDateChange: vi.fn(),
  deviceInfo: "",
  onDeviceInfoChange: vi.fn(),
  deviceInfoPlaceholder: "DevicePH",
  notesLabel: "Notes",
  notes: "",
  onNotesChange: vi.fn(),
  notesPlaceholder: "NotesPH",
  labels: {
    relyingPartyId: "RP ID",
    relyingPartyName: "RP Name",
    username: "Username",
    credentialId: "Credential ID",
    creationDate: "Creation",
    deviceInfo: "Device",
  },
};

describe("PasskeyFields", () => {
  it("renders all field labels", () => {
    render(<PasskeyFields {...baseProps} />);
    expect(screen.getByText("RP ID")).toBeInTheDocument();
    expect(screen.getByText("RP Name")).toBeInTheDocument();
    expect(screen.getByText("Username")).toBeInTheDocument();
    expect(screen.getByText("Credential ID")).toBeInTheDocument();
    expect(screen.getByText("Creation")).toBeInTheDocument();
    expect(screen.getByText("Device")).toBeInTheDocument();
  });

  it("propagates onCredentialIdChange via the visibility toggle input", () => {
    const onCredentialIdChange = vi.fn();
    render(
      <PasskeyFields
        {...baseProps}
        showCredentialId={true}
        onCredentialIdChange={onCredentialIdChange}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("CredPH"), { target: { value: "cred-123" } });
    expect(onCredentialIdChange).toHaveBeenCalledWith("cred-123");
  });

  it("hides credential id (type=password) when showCredentialId=false", () => {
    render(<PasskeyFields {...baseProps} showCredentialId={false} />);
    expect(screen.getByPlaceholderText("CredPH")).toHaveAttribute("type", "password");
  });
});
