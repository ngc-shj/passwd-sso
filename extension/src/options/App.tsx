import { useEffect, useState } from "react";
import { getSettings, setSettings, type StorageSchema } from "../lib/storage";
import { ensureHostPermission } from "../lib/api";
import { t } from "../lib/i18n";
import { humanizeError } from "../lib/error-messages";
import { useTheme } from "../lib/theme";

const DEFAULT_SERVER_URL = "https://localhost:3000";

function validateServerUrl(raw: string): { ok: boolean; value: string; error?: string } {
  const trimmed = raw.trim() || DEFAULT_SERVER_URL;
  try {
    const url = new URL(trimmed);
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
      return { ok: false, value: trimmed, error: "HTTPS_REQUIRED" };
    }
    const path = url.pathname.replace(/\/+$/, "");
    return { ok: true, value: `${url.origin}${path}` };
  } catch {
    return { ok: false, value: trimmed, error: "INVALID_URL" };
  }
}

function Toggle({
  checked,
  onChange,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      id={id}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 dark:focus:ring-offset-gray-800 ${
        checked ? "bg-blue-600 dark:bg-blue-500" : "bg-gray-300 dark:bg-gray-600"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function SettingRow({ label, description, children, htmlFor }: {
  label: string;
  description?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <label htmlFor={htmlFor} className="flex flex-col gap-0.5 cursor-pointer">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</span>
        {description && (
          <span className="text-xs text-gray-400 dark:text-gray-500">{description}</span>
        )}
      </label>
      {children}
    </div>
  );
}

const selectClass =
  "h-8 px-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:border-gray-900 dark:focus:border-gray-400 transition-shadow";

type SectionId = "general" | "autofill" | "notifications" | "security" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; labelKey: string; icon: string }[] = [
  { id: "general", labelKey: "options.sectionGeneral", icon: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7 7 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a7 7 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.212-1.281c-.062-.374-.312-.686-.644-.87a7 7 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a7 7 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
  { id: "autofill", labelKey: "options.sectionAutofill", icon: "M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" },
  { id: "notifications", labelKey: "options.sectionNotifications", icon: "M14.857 17.082a24 24 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.3 24.3 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" },
  { id: "security", labelKey: "options.sectionSecurity", icon: "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751A11.96 11.96 0 0 0 12 2.714Z" },
  { id: "shortcuts", labelKey: "options.sectionShortcuts", icon: "M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" },
  { id: "about", labelKey: "options.sectionAbout", icon: "M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" },
];

export function App() {
  const [theme, setTheme] = useTheme();
  const [activeSection, setActiveSection] = useState<SectionId>("general");

  const [serverUrl, setServerUrl] = useState("");
  const [autoLockMinutes, setAutoLockMinutes] = useState(15);
  const [showBadgeCount, setShowBadgeCount] = useState(true);
  const [enableInlineSuggestions, setEnableInlineSuggestions] = useState(true);
  const [enableContextMenu, setEnableContextMenu] = useState(true);
  const [autoCopyTotp, setAutoCopyTotp] = useState(true);
  const [showSavePrompt, setShowSavePrompt] = useState(true);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(true);
  const [clipboardClearSeconds, setClipboardClearSeconds] = useState(30);
  const [vaultTimeoutAction, setVaultTimeoutAction] = useState<"lock" | "logout">("lock");

  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  const [version, setVersion] = useState("");

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings().then((s: StorageSchema) => {
      setServerUrl(s.serverUrl);
      setAutoLockMinutes(s.autoLockMinutes);
      setShowBadgeCount(s.showBadgeCount);
      setEnableInlineSuggestions(s.enableInlineSuggestions);
      setEnableContextMenu(s.enableContextMenu);
      setAutoCopyTotp(s.autoCopyTotp);
      setShowSavePrompt(s.showSavePrompt);
      setShowUpdatePrompt(s.showUpdatePrompt);
      setClipboardClearSeconds(s.clipboardClearSeconds);
      setVaultTimeoutAction(s.vaultTimeoutAction);
    });

    chrome.commands.getAll().then(setCommands);
    setVersion(chrome.runtime.getManifest().version);
  }, []);

  const handleSave = async () => {
    setSaved(false);
    setError("");

    const validated = validateServerUrl(serverUrl);
    if (!validated.ok) {
      setError(validated.error || "INVALID_URL");
      return;
    }

    if (autoLockMinutes < 0 || !Number.isFinite(autoLockMinutes)) {
      setError("AUTO_LOCK_INVALID");
      return;
    }

    const granted = await ensureHostPermission(validated.value);
    if (!granted) {
      setError("PERMISSION_DENIED");
      return;
    }

    await setSettings({
      serverUrl: validated.value,
      autoLockMinutes,
      theme,
      showBadgeCount,
      enableInlineSuggestions,
      enableContextMenu,
      autoCopyTotp,
      showSavePrompt,
      showUpdatePrompt,
      clipboardClearSeconds,
      vaultTimeoutAction,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const renderSection = () => {
    switch (activeSection) {
      case "general":
        return (
          <>
            <div className="py-3 flex flex-col gap-1.5">
              <label htmlFor="server-url" className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {t("options.serverUrl")}
              </label>
              <input
                id="server-url"
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder={t("options.serverUrlPlaceholder")}
                className="h-9 px-3 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:border-gray-900 dark:focus:border-gray-400 transition-shadow"
              />
              <span className="text-xs text-gray-400 dark:text-gray-500">{t("options.httpsRequired")}</span>
            </div>
            <SettingRow label={t("options.theme")} htmlFor="theme-select">
              <select
                id="theme-select"
                value={theme}
                onChange={(e) => setTheme(e.target.value as "light" | "dark" | "system")}
                className={selectClass}
              >
                <option value="light">{t("options.themeLight")}</option>
                <option value="dark">{t("options.themeDark")}</option>
                <option value="system">{t("options.themeSystem")}</option>
              </select>
            </SettingRow>
            <SettingRow label={t("options.showBadgeCount")} description={t("options.showBadgeCountHint")} htmlFor="badge-count">
              <Toggle id="badge-count" checked={showBadgeCount} onChange={setShowBadgeCount} />
            </SettingRow>
          </>
        );

      case "autofill":
        return (
          <>
            <SettingRow label={t("options.enableInlineSuggestions")} description={t("options.enableInlineSuggestionsHint")} htmlFor="inline-suggestions">
              <Toggle id="inline-suggestions" checked={enableInlineSuggestions} onChange={setEnableInlineSuggestions} />
            </SettingRow>
            <SettingRow label={t("options.enableContextMenu")} description={t("options.enableContextMenuHint")} htmlFor="context-menu">
              <Toggle id="context-menu" checked={enableContextMenu} onChange={setEnableContextMenu} />
            </SettingRow>
            <SettingRow label={t("options.autoCopyTotp")} description={t("options.autoCopyTotpHint")} htmlFor="auto-copy-totp">
              <Toggle id="auto-copy-totp" checked={autoCopyTotp} onChange={setAutoCopyTotp} />
            </SettingRow>
          </>
        );

      case "notifications":
        return (
          <>
            <SettingRow label={t("options.showSavePrompt")} description={t("options.showSavePromptHint")} htmlFor="save-prompt">
              <Toggle id="save-prompt" checked={showSavePrompt} onChange={setShowSavePrompt} />
            </SettingRow>
            <SettingRow label={t("options.showUpdatePrompt")} description={t("options.showUpdatePromptHint")} htmlFor="update-prompt">
              <Toggle id="update-prompt" checked={showUpdatePrompt} onChange={setShowUpdatePrompt} />
            </SettingRow>
          </>
        );

      case "security":
        return (
          <>
            <SettingRow label={t("options.autoLock")} description={t("options.autoLockTenantNote")} htmlFor="auto-lock">
              <select
                id="auto-lock"
                value={autoLockMinutes}
                onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
                className={selectClass}
              >
                <option value={0}>{t("options.never")}</option>
                <option value={1}>{t("options.minutes", { n: "1" })}</option>
                <option value={5}>{t("options.minutes", { n: "5" })}</option>
                <option value={15}>{t("options.minutes", { n: "15" })}</option>
                <option value={30}>{t("options.minutes", { n: "30" })}</option>
                <option value={60}>{t("options.minutes", { n: "60" })}</option>
              </select>
            </SettingRow>
            <SettingRow label={t("options.clipboardClear")} description={t("options.clipboardClearHint")} htmlFor="clipboard-clear">
              <select
                id="clipboard-clear"
                value={clipboardClearSeconds}
                onChange={(e) => setClipboardClearSeconds(Number(e.target.value))}
                className={selectClass}
              >
                <option value={10}>{t("options.seconds", { n: "10" })}</option>
                <option value={20}>{t("options.seconds", { n: "20" })}</option>
                <option value={30}>{t("options.seconds", { n: "30" })}</option>
                <option value={60}>{t("options.minutes", { n: "1" })}</option>
                <option value={120}>{t("options.minutes", { n: "2" })}</option>
                <option value={300}>{t("options.minutes", { n: "5" })}</option>
              </select>
            </SettingRow>
            <SettingRow label={t("options.vaultTimeoutAction")} description={t("options.vaultTimeoutLogoutHint")} htmlFor="vault-timeout-action">
              <select
                id="vault-timeout-action"
                value={vaultTimeoutAction}
                onChange={(e) => setVaultTimeoutAction(e.target.value as "lock" | "logout")}
                className={selectClass}
              >
                <option value="lock">{t("options.vaultTimeoutLock")}</option>
                <option value="logout">{t("options.vaultTimeoutLogout")}</option>
              </select>
            </SettingRow>
          </>
        );

      case "shortcuts":
        return (
          <>
            {commands.length === 0 ? (
              <p className="py-3 text-sm text-gray-400 dark:text-gray-500">
                {t("options.shortcutsHint")}
              </p>
            ) : (
              commands.map((cmd) => {
                let desc = cmd.description?.replace(/__MSG_(\w+)__/g, (_m, key) =>
                  chrome.i18n?.getMessage(key) || key) || "";
                if (!desc && cmd.name === "_execute_action") {
                  desc = chrome.i18n?.getMessage("cmdOpenPopup") || "Open popup";
                }
                if (!desc) desc = cmd.name ?? "Unknown";
                return (
                  <div key={cmd.name} className="flex items-center justify-between gap-4 py-3">
                    <span className="text-sm text-gray-700 dark:text-gray-200">
                      {desc}
                    </span>
                    {cmd.shortcut ? (
                      <kbd className="inline-flex items-center rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-2 py-0.5 text-xs font-mono text-gray-600 dark:text-gray-300">
                        {cmd.shortcut}
                      </kbd>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-gray-500">{t("options.noShortcut")}</span>
                    )}
                  </div>
                );
              })
            )}
            <div className="pt-2 flex flex-col gap-2">
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("options.shortcutsHint")}</p>
              <button
                type="button"
                onClick={() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline text-left"
              >
                {t("options.customizeShortcuts")}
              </button>
            </div>
          </>
        );

      case "about":
        return (
          <>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-gray-700 dark:text-gray-200">{t("options.version")}</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">{version}</span>
            </div>
            <div className="py-3">
              <a
                href={validateServerUrl(serverUrl).ok ? validateServerUrl(serverUrl).value : DEFAULT_SERVER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t("options.openWebApp")}
              </a>
            </div>
          </>
        );
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t("options.title")}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("options.description")}</p>
          </div>
          <button
            type="button"
            onClick={() => window.close()}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors"
            aria-label={t("options.close")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </header>

        <div className="flex gap-8">
          {/* Left sidebar navigation */}
          <nav className="w-56 shrink-0">
            <ul className="flex flex-col gap-0.5 sticky top-10">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActiveSection(s.id)}
                    className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors whitespace-nowrap flex items-center gap-2 ${
                      activeSection === s.id
                        ? "bg-gray-200 dark:bg-gray-700 font-medium text-gray-900 dark:text-gray-100"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-200"
                    }`}
                  >
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d={s.icon} />
                    </svg>
                    {t(s.labelKey)}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Right content area */}
          <main className="flex-1 min-w-0">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm px-5 py-1">
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {renderSection()}
              </div>
            </div>

            {/* Save button — always visible */}
            <div className="flex items-center gap-3 mt-6">
              <button
                type="button"
                onClick={handleSave}
                className="px-5 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 active:bg-gray-950 transition-colors shadow-sm"
              >
                {t("options.save")}
              </button>
              {error && <span className="text-sm text-red-600 dark:text-red-400">{humanizeError(error)}</span>}
              {saved && <span className="text-sm text-green-600 dark:text-green-400 font-medium">{t("options.saved")}</span>}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
