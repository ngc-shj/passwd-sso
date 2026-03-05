"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { scanImageForQR, parseOtpauthUri } from "@/lib/qr-scanner-client";
import type { EntryTotp } from "@/lib/entry-form-types";
import { Camera, Upload, AlertTriangle } from "lucide-react";

interface QRCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTotpDetected: (totp: EntryTotp) => void;
}

const MAX_DIMENSION = 4096;

export function QRCaptureDialog({
  open,
  onOpenChange,
  onTotpDetected,
}: QRCaptureDialogProps) {
  const t = useTranslations("TOTP");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const processImage = useCallback(
    (imageData: ImageData) => {
      const qrText = scanImageForQR(imageData);
      if (!qrText) {
        setError(t("qrNotFound"));
        return;
      }

      const totp = parseOtpauthUri(qrText);
      if (!totp) {
        setError(t("qrNotTotp"));
        return;
      }

      onTotpDetected(totp);
      onOpenChange(false);
      setError(null);
    },
    [t, onTotpDetected, onOpenChange],
  );

  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setError(null);

      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      img.onload = () => {
        try {
          if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
            setError(t("qrImageTooLarge"));
            return;
          }

          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, img.width, img.height);
          processImage(imageData);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setError(t("qrImageLoadFailed"));
      };

      img.src = objectUrl;

      // Reset input so same file can be selected again
      event.target.value = "";
    },
    [t, processImage],
  );

  const handleScreenCapture = useCallback(async () => {
    setError(null);
    setScanning(true);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: MAX_DIMENSION }, height: { max: MAX_DIMENSION } },
      });

      const track = stream.getVideoTracks()[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imageCapture = new (window as any).ImageCapture(track);
      const bitmap: ImageBitmap = await imageCapture.grabFrame();

      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      processImage(imageData);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        // User cancelled the screen share dialog
        setError(null);
      } else {
        setError(t("qrCaptureFailed"));
      }
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      setScanning(false);
    }
  }, [t, processImage]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("qrScanTitle")}</DialogTitle>
          <DialogDescription>{t("qrScanDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{t("qrScreenCaptureNote")}</span>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={handleScreenCapture}
              disabled={scanning}
            >
              <Camera className="h-4 w-4 mr-2" />
              {scanning ? t("qrScanning") : t("qrCaptureScreen")}
            </Button>

            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4 mr-2" />
              {t("qrUploadImage")}
            </Button>
          </div>

          <div className="hidden">
            <Label htmlFor="qr-file-input" className="sr-only">
              {t("qrUploadImage")}
            </Label>
            <Input
              id="qr-file-input"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {/* Hidden canvas for image processing */}
          <canvas ref={canvasRef} className="hidden" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
