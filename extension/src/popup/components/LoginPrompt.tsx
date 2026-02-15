import { useEffect, useState } from "react";
import { getSettings } from "../../lib/storage";
import { t } from "../../lib/i18n";
import { EXT_CONNECT_PARAM } from "../../lib/constants";

export function LoginPrompt() {
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => {
    getSettings().then((s) => setServerUrl(s.serverUrl));
  }, []);

  const handleLogin = async () => {
    const { serverUrl } = await getSettings();
    chrome.tabs.create({ url: `${serverUrl}/dashboard?${EXT_CONNECT_PARAM}=1` });
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
        className="cursor-pointer px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800 active:bg-gray-950 transition-colors"
      >
        {t("popup.openApp")}
      </button>
    </div>
  );
}
