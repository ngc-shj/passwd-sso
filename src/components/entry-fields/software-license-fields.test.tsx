// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SoftwareLicenseFields } from "./software-license-fields";

const baseProps = {
  softwareName: "",
  onSoftwareNameChange: vi.fn(),
  softwareNamePlaceholder: "SwPH",
  licenseKey: "",
  onLicenseKeyChange: vi.fn(),
  licenseKeyPlaceholder: "LkPH",
  showLicenseKey: false,
  onToggleLicenseKey: vi.fn(),
  version: "",
  onVersionChange: vi.fn(),
  versionPlaceholder: "VerPH",
  licensee: "",
  onLicenseeChange: vi.fn(),
  licenseePlaceholder: "LicPH",
  purchaseDate: "",
  onPurchaseDateChange: vi.fn(),
  expirationDate: "",
  onExpirationDateChange: vi.fn(),
  expiryError: null as string | null,
  notesLabel: "Notes",
  notes: "",
  onNotesChange: vi.fn(),
  notesPlaceholder: "NotesPH",
  labels: {
    softwareName: "Software",
    licenseKey: "License key",
    version: "Version",
    licensee: "Licensee",
    purchaseDate: "Purchase",
    expirationDate: "Expiry",
  },
};

describe("SoftwareLicenseFields", () => {
  it("renders all field labels", () => {
    render(<SoftwareLicenseFields {...baseProps} />);
    expect(screen.getByText("Software")).toBeInTheDocument();
    expect(screen.getByText("License key")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("Licensee")).toBeInTheDocument();
    expect(screen.getByText("Purchase")).toBeInTheDocument();
    expect(screen.getByText("Expiry")).toBeInTheDocument();
  });

  it("renders expiryError when provided", () => {
    render(<SoftwareLicenseFields {...baseProps} expiryError="Expired" />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("hides license key (type=password) when showLicenseKey=false", () => {
    render(<SoftwareLicenseFields {...baseProps} showLicenseKey={false} />);
    expect(screen.getByPlaceholderText("LkPH")).toHaveAttribute("type", "password");
  });

  it("propagates onLicenseKeyChange when license key is visible", () => {
    const onLicenseKeyChange = vi.fn();
    render(
      <SoftwareLicenseFields
        {...baseProps}
        showLicenseKey={true}
        onLicenseKeyChange={onLicenseKeyChange}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("LkPH"), { target: { value: "ABCD-1234" } });
    expect(onLicenseKeyChange).toHaveBeenCalledWith("ABCD-1234");
  });

  const fieldHandlers = [
    ["Software", "onSoftwareNameChange", "Editor Pro"],
    ["License key", "onLicenseKeyChange", "ABCD-1234"],
    ["Version", "onVersionChange", "2.1"],
    ["Licensee", "onLicenseeChange", "Acme"],
    ["Purchase", "onPurchaseDateChange", "2024-01-01"],
    ["Expiry", "onExpirationDateChange", "2026-01-01"],
  ] as const;

  it.each(fieldHandlers)("routes a change in the %s field to %s only", (label, handler, value) => {
    const handlers = Object.fromEntries(fieldHandlers.map(([, name]) => [name, vi.fn()]));
    render(<SoftwareLicenseFields {...baseProps} {...handlers} />);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(handlers[handler]).toHaveBeenCalledWith(value);
    for (const [name, fn] of Object.entries(handlers)) {
      if (name !== handler) expect(fn).not.toHaveBeenCalled();
    }
  });
});
