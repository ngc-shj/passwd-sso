// Passkey selection dropdown — shown when a website requests WebAuthn authentication
// and passwd-sso has matching credentials. Renders in Shadow DOM.

import type { PasskeyMatchEntry } from "../../types/messages";
import { getShadowHost } from "./shadow-host";
import { t } from "../../lib/i18n";

const DROPDOWN_ID = "psso-passkey-dropdown";
const STYLE_ID = "psso-passkey-dropdown-style";
const OVERLAY_ID = "psso-passkey-overlay";

export interface PasskeyDropdownOptions {
  entries: PasskeyMatchEntry[];
  rpId: string;
  onSelect: (entry: PasskeyMatchEntry) => void;
  onPlatform: () => void;
  onCancel: () => void;
}

let activeIndex = -1;
let itemElements: HTMLDivElement[] = [];
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const PASSKEY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M15.75 1.5a6.75 6.75 0 0 0-6.651 7.906l-5.97 5.97a.75.75 0 0 0-.22.53v4.344a.75.75 0 0 0 .75.75h2.25a.75.75 0 0 0 .75-.75v-1.5h1.5a.75.75 0 0 0 .75-.75v-1.5h1.5a.75.75 0 0 0 .53-.22l.97-.97A6.75 6.75 0 1 0 15.75 1.5Zm2.25 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" clip-rule="evenodd"/></svg>`;

const DEVICE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M10.5 18.75a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z"/><path fill-rule="evenodd" d="M8.625.75A3.375 3.375 0 0 0 5.25 4.125v15.75a3.375 3.375 0 0 0 3.375 3.375h6.75a3.375 3.375 0 0 0 3.375-3.375V4.125A3.375 3.375 0 0 0 15.375.75h-6.75ZM7.5 4.125C7.5 3.504 8.004 3 8.625 3h6.75C15.996 3 16.5 3.504 16.5 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-6.75A1.125 1.125 0 0 1 7.5 19.875V4.125Z" clip-rule="evenodd"/></svg>`;

export function showPasskeyDropdown(opts: PasskeyDropdownOptions): void {
  hidePasskeyDropdown();

  const { root } = getShadowHost();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PASSKEY_DROPDOWN_STYLES;
  root.appendChild(style);

  // Backdrop overlay
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) opts.onCancel();
  });

  // Dropdown container
  const dropdown = document.createElement("div");
  dropdown.id = DROPDOWN_ID;
  dropdown.setAttribute("role", "dialog");
  dropdown.setAttribute("aria-label", "Select a passkey");

  // Header
  const header = document.createElement("div");
  header.className = "psso-pk-header";
  header.textContent = t("passkeyDropdown.signInTo", { rpId: opts.rpId });
  dropdown.appendChild(header);

  // Subtitle
  const subtitle = document.createElement("div");
  subtitle.className = "psso-pk-subtitle";
  subtitle.textContent = t("passkeyDropdown.choosePasskey");
  dropdown.appendChild(subtitle);

  // Entry list
  itemElements = [];
  activeIndex = -1;

  for (const entry of opts.entries) {
    const item = document.createElement("div");
    item.className = "psso-pk-item";
    item.setAttribute("role", "option");
    item.setAttribute("data-entry-id", entry.id);

    const icon = document.createElement("div");
    icon.className = "psso-pk-item-icon";
    icon.innerHTML = PASSKEY_ICON;

    const text = document.createElement("div");
    text.className = "psso-pk-item-text";

    const title = document.createElement("div");
    title.className = "psso-pk-item-title";
    title.textContent = entry.title;

    const username = document.createElement("div");
    username.className = "psso-pk-item-username";
    username.textContent = entry.username;

    text.appendChild(title);
    text.appendChild(username);

    if (entry.creationDate) {
      const date = document.createElement("div");
      date.className = "psso-pk-item-date";
      date.textContent = formatCreationDate(entry.creationDate);
      text.appendChild(date);
    }
    item.appendChild(icon);
    item.appendChild(text);

    item.addEventListener("click", () => opts.onSelect(entry));
    dropdown.appendChild(item);
    itemElements.push(item);
  }

  // Separator
  const sep = document.createElement("div");
  sep.className = "psso-pk-separator";
  dropdown.appendChild(sep);

  // Platform authenticator option
  const platformItem = document.createElement("div");
  platformItem.className = "psso-pk-item psso-pk-platform";
  platformItem.setAttribute("role", "option");

  const platformIcon = document.createElement("div");
  platformIcon.className = "psso-pk-item-icon psso-pk-device-icon";
  platformIcon.innerHTML = DEVICE_ICON;

  const platformText = document.createElement("div");
  platformText.className = "psso-pk-item-text";
  const platformTitle = document.createElement("div");
  platformTitle.className = "psso-pk-item-title";
  platformTitle.textContent = t("passkeyDropdown.useDevicePasskey");
  platformText.appendChild(platformTitle);

  platformItem.appendChild(platformIcon);
  platformItem.appendChild(platformText);
  platformItem.addEventListener("click", () => opts.onPlatform());
  dropdown.appendChild(platformItem);
  itemElements.push(platformItem);

  // Cancel button
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "psso-pk-cancel";
  cancelBtn.textContent = t("passkeyDropdown.cancel");
  cancelBtn.addEventListener("click", () => opts.onCancel());
  dropdown.appendChild(cancelBtn);

  overlay.appendChild(dropdown);
  root.appendChild(overlay);

  // Keyboard navigation
  keyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      opts.onCancel();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, itemElements.length - 1);
      updateActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive();
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      itemElements[activeIndex].click();
    }
  };
  document.addEventListener("keydown", keyHandler, true);
}

function formatCreationDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function updateActive(): void {
  for (let i = 0; i < itemElements.length; i++) {
    itemElements[i].setAttribute("data-active", i === activeIndex ? "true" : "false");
  }
}

export function hidePasskeyDropdown(): void {
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }
  itemElements = [];
  activeIndex = -1;
  try {
    const { root } = getShadowHost();
    const overlay = root.querySelector(`#${OVERLAY_ID}`);
    if (overlay) overlay.remove();
    const style = root.querySelector(`#${STYLE_ID}`);
    if (style) style.remove();
  } catch {
    // Shadow host may not exist
  }
}

const PASSKEY_DROPDOWN_STYLES = `
  #${OVERLAY_ID} {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2147483647;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    animation: psso-pk-fade-in 0.15s ease-out;
  }
  @keyframes psso-pk-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  #${DROPDOWN_ID} {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    min-width: 320px;
    max-width: 400px;
    max-height: 80vh;
    overflow-y: auto;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    color: #1f2937;
    animation: psso-pk-slide-up 0.2s ease-out;
  }
  @keyframes psso-pk-slide-up {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  .psso-pk-header {
    padding: 16px 20px 4px;
    font-size: 16px;
    font-weight: 600;
    color: #111827;
  }
  .psso-pk-subtitle {
    padding: 0 20px 12px;
    font-size: 12px;
    color: #6b7280;
  }
  .psso-pk-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 20px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .psso-pk-item:hover,
  .psso-pk-item[data-active="true"] {
    background: #eff6ff;
  }
  .psso-pk-item-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #dbeafe;
    border-radius: 8px;
    color: #2563eb;
  }
  .psso-pk-device-icon {
    background: #f3f4f6;
    color: #6b7280;
  }
  .psso-pk-item-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .psso-pk-item-title {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .psso-pk-item-username {
    font-size: 12px;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .psso-pk-item-date {
    font-size: 11px;
    color: #9ca3af;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .psso-pk-separator {
    height: 1px;
    background: #e5e7eb;
    margin: 4px 0;
  }
  .psso-pk-platform {
    opacity: 0.85;
  }
  .psso-pk-cancel {
    display: block;
    width: calc(100% - 40px);
    margin: 8px 20px 16px;
    padding: 8px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #fff;
    color: #374151;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-align: center;
    transition: background 0.1s;
  }
  .psso-pk-cancel:hover {
    background: #f9fafb;
  }
`;
