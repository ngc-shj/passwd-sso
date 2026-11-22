// @vitest-environment jsdom
/**
 * QRCaptureDialog — file upload / screen capture flows.
 *
 * Covers:
 *   - File upload happy path: valid otpauth URI → onTotpDetected fires + dialog closes
 *   - File upload: QR not found error
 *   - File upload: QR found but not otpauth URI
 *   - File upload: image dimensions exceed MAX_IMAGE_DIMENSION → blocks scan
 *   - "Scanning…" disables the screen-capture button (R26 disabled cue)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockScanImageForQR, mockParseOtpauthUri } = vi.hoisted(() => ({
  mockScanImageForQR: vi.fn(),
  mockParseOtpauthUri: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/ui/qr-scanner-client", () => ({
  scanImageForQR: (...args: unknown[]) => mockScanImageForQR(...args),
  parseOtpauthUri: (...args: unknown[]) => mockParseOtpauthUri(...args),
}));

vi.mock("@/lib/validations/common", () => ({
  MAX_IMAGE_DIMENSION: 4096,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button
      disabled={disabled}
      onClick={onClick}
      data-disabled={disabled ? "true" : undefined}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    function MockInput(props, ref) {
      return <input ref={ref} {...props} />;
    },
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.ComponentProps<"label">) => (
    <label {...rest}>{children}</label>
  ),
}));

import { QRCaptureDialog } from "./qr-capture-dialog";

// ── Helpers — mock browser image-loading APIs ──────────────────────

interface MockImageInstance {
  width: number;
  height: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

function installImageMock(opts: { width: number; height: number; trigger?: "load" | "error" }) {
  const instances: MockImageInstance[] = [];
  class FakeImage {
    width = 0;
    height = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      this.width = opts.width;
      this.height = opts.height;
      instances.push(this);
      // queueMicrotask so onload assignment lands before firing
      queueMicrotask(() => {
        if (opts.trigger === "error") this.onerror?.();
        else this.onload?.();
      });
    }
    get src() {
      return "";
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Image = FakeImage;
  return instances;
}

function installCanvasMock() {
  // jsdom canvas getContext returns null by default — stub it.
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () =>
      ({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // URL.createObjectURL / revokeObjectURL — jsdom omits these
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).createObjectURL = vi.fn(() => "blob:mock");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).revokeObjectURL = vi.fn();
  installCanvasMock();
});

describe("QRCaptureDialog", () => {
  it("calls onTotpDetected and closes the dialog when QR contains a valid otpauth URI", async () => {
    installImageMock({ width: 200, height: 200 });
    mockScanImageForQR.mockReturnValue("otpauth://totp/Issuer:user?secret=ABC");
    mockParseOtpauthUri.mockReturnValue({ secret: "ABC", issuer: "Issuer" });
    const onTotpDetected = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <QRCaptureDialog open={true} onOpenChange={onOpenChange} onTotpDetected={onTotpDetected} />,
    );

    const file = new File(["data"], "qr.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(onTotpDetected).toHaveBeenCalledWith({ secret: "ABC", issuer: "Issuer" });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders qrNotFound error when no QR code is detected", async () => {
    installImageMock({ width: 200, height: 200 });
    mockScanImageForQR.mockReturnValue(null);

    render(
      <QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />,
    );

    const file = new File(["data"], "qr.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("qrNotFound")).toBeInTheDocument();
    });
    expect(mockParseOtpauthUri).not.toHaveBeenCalled();
  });

  it("renders qrNotTotp error when QR is not an otpauth URI", async () => {
    installImageMock({ width: 200, height: 200 });
    mockScanImageForQR.mockReturnValue("https://example.com");
    mockParseOtpauthUri.mockReturnValue(null);

    render(
      <QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />,
    );

    const file = new File(["data"], "qr.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("qrNotTotp")).toBeInTheDocument();
    });
  });

  it("renders qrImageTooLarge error when uploaded image exceeds MAX_IMAGE_DIMENSION", async () => {
    installImageMock({ width: 5000, height: 5000 });

    render(
      <QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />,
    );

    const file = new File(["data"], "huge.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("qrImageTooLarge")).toBeInTheDocument();
    });
    expect(mockScanImageForQR).not.toHaveBeenCalled();
  });

  it("renders nothing when open is false", () => {
    render(
      <QRCaptureDialog open={false} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />,
    );
    expect(screen.queryByTestId("dialog")).toBeNull();
  });
});

function uploadFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["data"], "qr.png", { type: "image/png" })] } });
  return input;
}

describe("QRCaptureDialog — file upload housekeeping", () => {
  it("shows qrImageLoadFailed and releases the object URL when the image cannot be decoded", async () => {
    installImageMock({ width: 200, height: 200, trigger: "error" });
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    uploadFile();

    expect(await screen.findByText("qrImageLoadFailed")).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    expect(mockScanImageForQR).not.toHaveBeenCalled();
  });

  it("releases the object URL after a decoded image is scanned", async () => {
    installImageMock({ width: 200, height: 200 });
    mockScanImageForQR.mockReturnValue(null);
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    uploadFile();

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock"));
    expect(mockScanImageForQR).toHaveBeenCalledTimes(1);
  });

  it("clears the file input so the same file can be chosen again", () => {
    installImageMock({ width: 200, height: 200 });
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    const input = uploadFile();

    expect(input.value).toBe("");
  });

  it("ignores a change event that carries no file", () => {
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("opens the hidden file picker from the upload button", () => {
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");

    fireEvent.click(screen.getByRole("button", { name: "qrUploadImage" }));

    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("QRCaptureDialog — screen capture", () => {
  let stopTrack: ReturnType<typeof vi.fn>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  let closeBitmap: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stopTrack = vi.fn();
    closeBitmap = vi.fn();
    const track = { stop: stopTrack };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    getDisplayMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getDisplayMedia },
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
  });

  function installImageCapture() {
    const bitmap = { width: 300, height: 200, close: closeBitmap };
    vi.stubGlobal(
      "ImageCapture",
      class {
        grabFrame() {
          return Promise.resolve(bitmap);
        }
      },
    );
  }

  it("scans a grabbed frame, reports the TOTP, closes the dialog and stops the share", async () => {
    installImageCapture();
    mockScanImageForQR.mockReturnValue("otpauth://totp/X?secret=S");
    mockParseOtpauthUri.mockReturnValue({ secret: "S" });
    const onTotpDetected = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <QRCaptureDialog open={true} onOpenChange={onOpenChange} onTotpDetected={onTotpDetected} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "qrCaptureScreen" }));

    await waitFor(() => expect(onTotpDetected).toHaveBeenCalledWith({ secret: "S" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(closeBitmap).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("caps the requested capture size at MAX_IMAGE_DIMENSION", async () => {
    installImageCapture();
    mockScanImageForQR.mockReturnValue(null);
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "qrCaptureScreen" }));

    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(1));
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { width: { max: 4096 }, height: { max: 4096 } },
    });
  });

  it("shows qrCaptureFailed and stops the share when ImageCapture is unsupported", async () => {
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "qrCaptureScreen" }));

    expect(await screen.findByText("qrCaptureFailed")).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "qrCaptureScreen" })).toBeEnabled();
  });

  it("shows no error when the user cancels the screen-share prompt", async () => {
    getDisplayMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "qrCaptureScreen" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "qrCaptureScreen" })).toBeEnabled(),
    );
    expect(screen.queryByText("qrCaptureFailed")).not.toBeInTheDocument();
    expect(stopTrack).not.toHaveBeenCalled();
  });

  it("disables the capture button and shows the scanning label while the share is pending", async () => {
    getDisplayMedia.mockReturnValue(new Promise(() => {}));
    render(<QRCaptureDialog open={true} onOpenChange={vi.fn()} onTotpDetected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "qrCaptureScreen" }));

    expect(await screen.findByRole("button", { name: "qrScanning" })).toBeDisabled();
  });
});

