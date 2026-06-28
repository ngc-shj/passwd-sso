import { t } from "../../lib/i18n";

interface FillMismatchDialogProps {
  title: string;
  savedHost: string;
  currentHost: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Confirmation shown before autofilling a LOGIN whose stored host differs from the
// current tab (phishing safeguard, mirrors the iOS AutoFill extension).
export function FillMismatchDialog({
  title,
  savedHost,
  currentHost,
  onConfirm,
  onCancel,
}: FillMismatchDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("popup.fillMismatchTitle")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-xs rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg p-4 flex flex-col gap-3">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-2xl text-amber-500" aria-hidden="true">⚠</span>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("popup.fillMismatchTitle")}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-line">
            {t("popup.fillMismatchSavedFor", { title, host: savedHost })}
          </p>
          {currentHost && (
            <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-line">
              {t("popup.fillMismatchCurrentSite", { host: currentHost })}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={onConfirm}
            className="h-9 rounded-md text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 active:bg-amber-800 transition-colors"
          >
            {t("popup.fillAnyway")}
          </button>
          <button
            onClick={onCancel}
            className="h-9 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            {t("popup.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
