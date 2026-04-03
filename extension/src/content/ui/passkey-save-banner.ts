// Passkey save banner — shown when navigator.credentials.create() is intercepted.
// Asks user if they want to save the new passkey in passwd-sso.

import { getShadowHost } from "./shadow-host";

const BANNER_ID = "psso-passkey-save-banner";
const STYLE_ID = "psso-passkey-save-style";
const AUTO_DISMISS_MS = 15_000;

export interface PasskeySaveBannerOptions {
  rpName: string;
  userName: string;
  onSave: () => void;
  onDismiss: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showPasskeySaveBanner(options: PasskeySaveBannerOptions): void {
  hidePasskeySaveBanner();

  const { root } = getShadowHost();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BANNER_STYLES;
  root.appendChild(style);

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "alert");

  const message = document.createElement("div");
  message.className = "psso-pk-banner-message";
  message.textContent = `Save passkey for ${options.rpName}?`;

  if (options.userName) {
    const user = document.createElement("div");
    user.className = "psso-pk-banner-username";
    user.textContent = options.userName;
    message.appendChild(user);
  }

  const actions = document.createElement("div");
  actions.className = "psso-pk-banner-actions";

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save in passwd-sso";
  saveBtn.className = "psso-pk-btn-primary";
  saveBtn.addEventListener("click", () => {
    options.onSave();
    hidePasskeySaveBanner();
  });
  actions.appendChild(saveBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Use device";
  dismissBtn.className = "psso-pk-btn-secondary";
  dismissBtn.addEventListener("click", () => {
    options.onDismiss();
    hidePasskeySaveBanner();
  });
  actions.appendChild(dismissBtn);

  banner.appendChild(message);
  banner.appendChild(actions);
  root.appendChild(banner);

  dismissTimer = setTimeout(() => {
    options.onDismiss();
    hidePasskeySaveBanner();
  }, AUTO_DISMISS_MS);
}

export function hidePasskeySaveBanner(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  try {
    const { root } = getShadowHost();
    const banner = root.querySelector(`#${BANNER_ID}`);
    if (banner) banner.remove();
    const style = root.querySelector(`#${STYLE_ID}`);
    if (style) style.remove();
  } catch {
    // Shadow host may not exist
  }
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
    animation: psso-pk-banner-slide 0.2s ease-out;
  }
  @keyframes psso-pk-banner-slide {
    from { transform: translateY(-100%); }
    to { transform: translateY(0); }
  }
  .psso-pk-banner-message {
    flex: 1;
    min-width: 0;
  }
  .psso-pk-banner-username {
    font-size: 11px;
    color: #94a3b8;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .psso-pk-banner-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .psso-pk-btn-primary,
  .psso-pk-btn-secondary {
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    pointer-events: auto;
  }
  .psso-pk-btn-primary {
    background: #3b82f6;
    color: #fff;
  }
  .psso-pk-btn-primary:hover {
    background: #2563eb;
  }
  .psso-pk-btn-secondary {
    background: #334155;
    color: #cbd5e1;
  }
  .psso-pk-btn-secondary:hover {
    background: #475569;
  }
`;
