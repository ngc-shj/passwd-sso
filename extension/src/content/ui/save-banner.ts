// Save-login banner UI — shown after login form submission.
// Renders inside the existing Shadow DOM host for style isolation.

import { getShadowHost } from "./shadow-host";
import { t } from "../../lib/i18n";

const BANNER_ID = "psso-save-banner";
const AUTO_DISMISS_MS = 15_000;

export interface SaveBannerOptions {
  host: string;
  username: string;
  /** "save" = new entry, "update" = existing entry with different password */
  action: "save" | "update";
  existingTitle?: string;
  onSave: () => void;
  onUpdate: () => void;
  onDismiss: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showSaveBanner(options: SaveBannerOptions): void {
  hideSaveBanner();

  const { root } = getShadowHost();

  const style = document.createElement("style");
  style.textContent = BANNER_STYLES;
  root.appendChild(style);

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "alert");

  const message = document.createElement("div");
  message.className = "psso-banner-message";

  if (options.action === "update" && options.existingTitle) {
    message.textContent = t("saveBanner.updateLogin", { title: options.existingTitle });
  } else {
    message.textContent = t("saveBanner.saveLogin", { host: options.host });
  }

  if (options.username) {
    const user = document.createElement("div");
    user.className = "psso-banner-username";
    user.textContent = options.username;
    message.appendChild(user);
  }

  const actions = document.createElement("div");
  actions.className = "psso-banner-actions";

  if (options.action === "save") {
    const saveBtn = createButton(t("saveBanner.save"), "psso-btn-primary", () => {
      options.onSave();
      hideSaveBanner();
    });
    actions.appendChild(saveBtn);
  } else {
    const updateBtn = createButton(t("saveBanner.update"), "psso-btn-primary", () => {
      options.onUpdate();
      hideSaveBanner();
    });
    actions.appendChild(updateBtn);
  }

  const dismissBtn = createButton(t("saveBanner.dismiss"), "psso-btn-secondary", () => {
    options.onDismiss();
    hideSaveBanner();
  });
  actions.appendChild(dismissBtn);

  banner.appendChild(message);
  banner.appendChild(actions);
  root.appendChild(banner);

  // Auto-dismiss after 15 seconds
  dismissTimer = setTimeout(() => {
    options.onDismiss();
    hideSaveBanner();
  }, AUTO_DISMISS_MS);
}

export function hideSaveBanner(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  try {
    const { root } = getShadowHost();
    const banner = root.getElementById(BANNER_ID);
    if (banner) {
      // Also remove the style element we added
      const prev = banner.previousElementSibling;
      if (prev?.tagName === "STYLE") prev.remove();
      banner.remove();
    }
  } catch {
    // Shadow host may not exist
  }
}

function createButton(
  text: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = text;
  btn.className = className;
  btn.addEventListener("click", onClick);
  return btn;
}

const BANNER_STYLES = `
  #${BANNER_ID} {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    background: #1e293b;
    color: #f1f5f9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    animation: psso-slide-in 0.2s ease-out;
  }
  @keyframes psso-slide-in {
    from { transform: translateY(-100%); }
    to { transform: translateY(0); }
  }
  .psso-banner-message {
    flex: 1;
    min-width: 0;
  }
  .psso-banner-username {
    font-size: 11px;
    color: #94a3b8;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .psso-banner-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .psso-btn-primary,
  .psso-btn-secondary {
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    pointer-events: auto;
  }
  .psso-btn-primary {
    background: #3b82f6;
    color: #fff;
  }
  .psso-btn-primary:hover {
    background: #2563eb;
  }
  .psso-btn-secondary {
    background: #334155;
    color: #cbd5e1;
  }
  .psso-btn-secondary:hover {
    background: #475569;
  }
`;
