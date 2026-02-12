import { useEffect, useState } from "react";
import { getSettings } from "../../lib/storage";
import { t } from "../../lib/i18n";

export function LoginPrompt() {
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => {
    getSettings().then((s) => setServerUrl(s.serverUrl));
  }, []);

  const handleLogin = async () => {
    const { serverUrl } = await getSettings();
    chrome.tabs.create({ url: `${serverUrl}/dashboard` });
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      <p className="text-sm text-gray-600 text-center">
        {t("popup.signIn")}
      </p>
      {serverUrl && (
        <p className="text-xs text-gray-500 break-all text-center">
          {serverUrl}
        </p>
      )}
      <button
        onClick={handleLogin}
        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
      >
        {t("popup.openApp")}
      </button>
    </div>
  );
}
