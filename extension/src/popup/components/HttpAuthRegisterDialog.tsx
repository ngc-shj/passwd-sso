import { t } from "../../lib/i18n";

interface HttpAuthRegisterDialogProps {
  title: string;
  origin: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Confirmation before binding a LOGIN to a site's HTTP auth dialog (#905).
// onConfirm runs inside the click, so it can call chrome.permissions.request
// while the user gesture is still live.
export function HttpAuthRegisterDialog({ title, origin, onConfirm, onCancel }: HttpAuthRegisterDialogProps) {
  const insecure = origin.startsWith("http:");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("popup.httpAuthRegisterTitle")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-xs rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg p-4 flex flex-col gap-3">
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("popup.httpAuthRegisterTitle")}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 break-all">
            {t("popup.httpAuthRegisterBody", { origin, title })}
          </p>
          {insecure && (
            <p className="text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-md px-2 py-1.5 text-left">
              <span aria-hidden="true">⚠ </span>
              {t("popup.httpAuthRegisterHttpWarning")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={onConfirm}
            className="h-9 rounded-md text-sm font-medium text-white bg-gray-900 dark:bg-gray-200 dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-300 transition-colors"
          >
            {t("popup.httpAuthRegisterConfirm")}
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
