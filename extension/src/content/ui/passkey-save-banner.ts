import { getShadowHost } from "./shadow-host";
import { bannerStyles } from "./styles";
import { t } from "../../lib/i18n";
import type { PasskeyMatchEntry } from "../../types/messages";

const BANNER_ID = "psso-passkey-save-banner";
const STYLE_ID = "psso-passkey-save-style";
const AUTO_DISMISS_MS = 15_000;

export interface PasskeySaveBannerOptions {
  rpName: string;
  userName: string;
  existingEntries?: PasskeyMatchEntry[];
  onSave: (replaceEntryId?: string) => void;
  onDismiss: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showPasskeySaveBanner(options: PasskeySaveBannerOptions): void {
  hidePasskeySaveBanner();

  const { root } = getShadowHost();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = bannerStyles(BANNER_ID);
  root.appendChild(style);

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "alert");

  const existing = options.existingEntries ?? [];
  const hasExisting = existing.length > 0;

  const message = document.createElement("div");
  message.className = "psso-banner-message";
  message.textContent = hasExisting
    ? t("passkeySaveBanner.duplicateFound", { rpName: options.rpName })
    : t("passkeySaveBanner.savePasskey", { rpName: options.rpName });

  if (options.userName) {
    const user = document.createElement("div");
    user.className = "psso-banner-username";
    user.textContent = options.userName;
    message.appendChild(user);
  }

  const actions = document.createElement("div");
  actions.className = "psso-banner-actions";

  if (hasExisting) {
    // Keep both is the safe default — we cannot distinguish upgrade from
    // new registration based on WebAuthn params alone.
    const keepBothBtn = document.createElement("button");
    keepBothBtn.textContent = t("passkeySaveBanner.keepBoth");
    keepBothBtn.className = "psso-btn-primary";
    keepBothBtn.addEventListener("click", () => {
      options.onSave();
      hidePasskeySaveBanner();
    });
    actions.appendChild(keepBothBtn);

    if (existing.length === 1) {
      const replaceBtn = document.createElement("button");
      replaceBtn.textContent = t("passkeySaveBanner.replace");
      replaceBtn.className = "psso-btn-secondary";
      replaceBtn.addEventListener("click", () => {
        options.onSave(existing[0].id);
        hidePasskeySaveBanner();
      });
      actions.appendChild(replaceBtn);
    }
  } else {
    const saveBtn = document.createElement("button");
    saveBtn.textContent = t("passkeySaveBanner.save");
    saveBtn.className = "psso-btn-primary";
    saveBtn.addEventListener("click", () => {
      options.onSave();
      hidePasskeySaveBanner();
    });
    actions.appendChild(saveBtn);
  }

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = t("passkeySaveBanner.useDevice");
  dismissBtn.className = "psso-btn-secondary";
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
