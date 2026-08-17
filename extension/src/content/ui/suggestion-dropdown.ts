// Floating suggestion dropdown for inline autofill.
// Rendered inside a closed Shadow DOM to isolate styles.

import type { DecryptedEntry } from "../../types/messages";
import { MS_PER_SECOND } from "../../lib/time";
import { getShadowHost } from "./shadow-host";
import { DROPDOWN_STYLES } from "./styles";
import { KEY_ICON, LOCK_ICON, USER_ICON, DISCONNECT_ICON, CARD_ICON, ID_ICON } from "./icons";

// Message-only states (disconnected / locked / no matches) carry nothing to pick,
// so they linger over the page text under the field until the user clicks away.
// Dismiss them on a timer; the entries list has no timer, since it would expire
// while the user is still choosing a credential.
export const MESSAGE_AUTO_DISMISS_MS = 5 * MS_PER_SECOND;

export type DropdownEntryType = "LOGIN" | "CREDIT_CARD" | "IDENTITY";

export interface DropdownOptions {
  anchorRect: DOMRect;
  entries: DecryptedEntry[];
  vaultLocked: boolean;
  disconnected?: boolean;
  onSelect: (entryId: string, teamId?: string) => void;
  onDismiss: () => void;
  lockedMessage: string;
  disconnectedMessage?: string;
  noMatchesMessage: string;
  headerLabel: string;
  // Drives the per-item icon. Optional, defaults to "LOGIN" so existing callers
  // keep compiling unchanged.
  entryType?: DropdownEntryType;
}

function itemIconFor(entryType: DropdownEntryType): string {
  switch (entryType) {
    case "CREDIT_CARD":
      return CARD_ICON;
    case "IDENTITY":
      return ID_ICON;
    default:
      return KEY_ICON;
  }
}

let currentDropdown: HTMLDivElement | null = null;
let activeIndex = -1;
let itemElements: HTMLDivElement[] = [];
let currentOnDismiss: (() => void) | null = null;
let currentOnSelect: ((entryId: string, teamId?: string) => void) | null = null;
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
let outsideClickFrame: ReturnType<typeof requestAnimationFrame> | null = null;
let visibilityWatcher: (() => void) | null = null;

function isSafeSelectClick(e: MouseEvent, item: HTMLDivElement): boolean {
  if (!e.isTrusted) return false;
  const path = e.composedPath?.() ?? [];
  if (path.includes(item)) return true;
  const topEl = document.elementFromPoint(e.clientX, e.clientY);
  return topEl === item || (topEl instanceof Node && item.contains(topEl));
}

export function showDropdown(opts: DropdownOptions): void {
  hideDropdown();

  const { root } = getShadowHost();

  const style = document.createElement("style");
  style.textContent = DROPDOWN_STYLES;
  root.appendChild(style);

  // Set by the three message-only branches below; drives the auto-dismiss arm.
  let isMessageOnly = false;

  const dropdown = document.createElement("div");
  dropdown.className = "psso-dropdown";
  dropdown.style.pointerEvents = "auto";
  dropdown.setAttribute("role", "listbox");

  // Armed per message-only branch rather than from a single length check after the
  // fact, so a future fourth message state cannot miss the timer by forgetting to
  // update a separate predicate.
  if (opts.disconnected) {
    const disconnected = document.createElement("div");
    disconnected.className = "psso-disconnected";
    disconnected.innerHTML = `${DISCONNECT_ICON}<span>${escapeHtml(opts.disconnectedMessage || opts.lockedMessage)}</span>`;
    dropdown.appendChild(disconnected);
    isMessageOnly = true;
  } else if (opts.vaultLocked) {
    const locked = document.createElement("div");
    locked.className = "psso-locked";
    locked.innerHTML = `${LOCK_ICON}<span>${escapeHtml(opts.lockedMessage)}</span>`;
    dropdown.appendChild(locked);
    isMessageOnly = true;
  } else if (opts.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "psso-empty";
    empty.textContent = opts.noMatchesMessage;
    dropdown.appendChild(empty);
    isMessageOnly = true;
  } else {
    const header = document.createElement("div");
    header.className = "psso-dropdown-header";
    header.textContent = opts.headerLabel;
    dropdown.appendChild(header);

    itemElements = [];
    activeIndex = -1;

    const itemIcon = itemIconFor(opts.entryType ?? "LOGIN");

    for (const entry of opts.entries) {
      const item = document.createElement("div");
      item.className = "psso-item";
      item.setAttribute("role", "option");
      item.setAttribute("data-entry-id", entry.id);
      if (entry.teamId) item.setAttribute("data-team-id", entry.teamId);

      item.innerHTML = `
        <div class="psso-item-icon">${itemIcon}</div>
        <div class="psso-item-text">
          <div class="psso-item-title">${escapeHtml(entry.title || entry.urlHost)}</div>
          <div class="psso-item-username">${USER_ICON}<span>${escapeHtml(entry.username)}</span></div>
        </div>
      `;

      // Use mousedown + preventDefault to prevent input blur
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!isSafeSelectClick(e, item)) return;
        try {
          opts.onSelect(entry.id, entry.teamId);
        } catch {
          // Extension context may have been invalidated — swallow silently
        }
      });

      item.addEventListener("mouseenter", () => {
        setActiveItem(itemElements.indexOf(item));
      });

      dropdown.appendChild(item);
      itemElements.push(item);
    }
  }

  positionDropdown(dropdown, opts.anchorRect);
  root.appendChild(dropdown);
  currentDropdown = dropdown;
  currentOnDismiss = opts.onDismiss;
  currentOnSelect = opts.onSelect;

  // Armed only after the dropdown is live, so a throw above cannot leave a timer
  // running against a dropdown that was never shown. hideDropdown() at the top of
  // this function has already cleared any previous timer.
  if (isMessageOnly) {
    startVisibleCountdown();
  }

  // Click outside to dismiss (delayed to avoid triggering on the same click).
  // The frame handle is kept so hideDropdown() can cancel a still-pending callback:
  // a hidden tab pauses rAF while timers keep running, so the auto-dismiss can
  // easily land first and this callback would otherwise install a listener onto an
  // already-torn-down dropdown, with nothing left to remove it.
  outsideClickFrame = requestAnimationFrame(() => {
    outsideClickFrame = null;
    outsideClickHandler = (e: MouseEvent) => {
      const path = e.composedPath();
      if (!path.includes(dropdown)) {
        hideDropdown();
      }
    };
    document.addEventListener("mousedown", outsideClickHandler, true);
  });
}

// The countdown measures VISIBLE time. A notice the user never saw has not been
// read, and these three states are the only in-page signal that a dropdown is
// really ours — expiring one behind a background tab would quietly remove the
// warning a look-alike overlay has to compete with.
function startVisibleCountdown(): void {
  let remaining = MESSAGE_AUTO_DISMISS_MS;
  let startedAt = performance.now();

  const arm = () => {
    startedAt = performance.now();
    autoDismissTimer = setTimeout(() => hideDropdown(), remaining);
  };

  visibilityWatcher = () => {
    if (document.visibilityState === "hidden") {
      if (autoDismissTimer !== null) {
        clearTimeout(autoDismissTimer);
        autoDismissTimer = null;
        remaining = Math.max(0, remaining - (performance.now() - startedAt));
      }
    } else if (autoDismissTimer === null) {
      arm();
    }
  };
  document.addEventListener("visibilitychange", visibilityWatcher);

  if (document.visibilityState !== "hidden") arm();
}

export function hideDropdown(): void {
  // Cleared unconditionally and before fn() below: that call runs detector-supplied
  // code, and a callback that re-shows the dropdown would arm a timer this clear has
  // already passed — orphaning it onto whatever dropdown comes next.
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
  if (visibilityWatcher) {
    document.removeEventListener("visibilitychange", visibilityWatcher);
    visibilityWatcher = null;
  }
  // Cancel before the callback can run. Without this, a dismissal that beats the
  // frame — routine in a background tab, where rAF is paused and timers are not —
  // leaves the callback to install a document listener that nothing removes.
  if (outsideClickFrame !== null) {
    cancelAnimationFrame(outsideClickFrame);
    outsideClickFrame = null;
  }
  if (outsideClickHandler) {
    document.removeEventListener("mousedown", outsideClickHandler, true);
    outsideClickHandler = null;
  }
  if (currentDropdown) {
    // Remove all children from shadow root
    const { root } = getShadowHost();
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
    currentDropdown = null;
    itemElements = [];
    activeIndex = -1;
  }
  if (currentOnDismiss) {
    const fn = currentOnDismiss;
    currentOnDismiss = null;
    fn();
  }
  currentOnSelect = null;
}

export function isDropdownVisible(): boolean {
  return currentDropdown !== null;
}

export function handleDropdownKeydown(e: KeyboardEvent): boolean {
  // Presence-only. The item-list requirement belongs to the navigation cases, which
  // index itemElements; Escape does not, and gating it here made Escape a no-op in
  // the three message-only states — the states with nothing to navigate.
  if (!currentDropdown) return false;

  switch (e.key) {
    case "ArrowDown": {
      if (itemElements.length === 0) return false;
      e.preventDefault();
      setActiveItem(activeIndex < itemElements.length - 1 ? activeIndex + 1 : 0);
      return true;
    }
    case "ArrowUp": {
      if (itemElements.length === 0) return false;
      e.preventDefault();
      setActiveItem(activeIndex > 0 ? activeIndex - 1 : itemElements.length - 1);
      return true;
    }
    case "Enter": {
      // A fill is a credential disclosure — only a trusted (real) keypress may
      // trigger it. Blocks a page script dispatching synthetic ArrowDown+Enter
      // to auto-select and exfiltrate the entry (mirrors isSafeSelectClick on
      // the mouse path). Navigation keys above are cosmetic and need no guard.
      if (!e.isTrusted) return false;
      if (activeIndex >= 0 && activeIndex < itemElements.length) {
        e.preventDefault();
        const activeItem = itemElements[activeIndex];
        const entryId = activeItem?.getAttribute("data-entry-id");
        const teamId = activeItem?.getAttribute("data-team-id") ?? undefined;
        if (entryId && currentOnSelect) {
          try {
            currentOnSelect(entryId, teamId);
          } catch {
            // Extension context may have been invalidated — swallow silently
          }
        }
        return true;
      }
      return false;
    }
    case "Escape": {
      // Trusted-only, matching the Enter case and isSafeSelectClick. A synthetic
      // Escape would otherwise let a page suppress the locked / no-match notice on
      // demand — the user's only in-page signal that a dropdown is really ours —
      // and the resulting defaultPrevented would tell the page whether a message
      // state is showing. Returning early leaves defaultPrevented false.
      if (!e.isTrusted) return false;
      e.preventDefault();
      hideDropdown();
      return true;
    }
    default:
      return false;
  }
}

function setActiveItem(index: number): void {
  if (activeIndex >= 0 && activeIndex < itemElements.length) {
    itemElements[activeIndex].removeAttribute("data-active");
  }
  activeIndex = index;
  if (activeIndex >= 0 && activeIndex < itemElements.length) {
    itemElements[activeIndex].setAttribute("data-active", "true");
    itemElements[activeIndex].scrollIntoView?.({ block: "nearest" });
  }
}

function positionDropdown(dropdown: HTMLDivElement, anchorRect: DOMRect): void {
  const gap = 4;
  const viewportHeight = window.innerHeight;

  let top = anchorRect.bottom + gap;
  // If not enough space below, position above
  if (top + 200 > viewportHeight && anchorRect.top > 200) {
    top = anchorRect.top - gap;
    dropdown.style.transform = "translateY(-100%)";
  }

  dropdown.style.position = "fixed";
  dropdown.style.top = `${top}px`;
  dropdown.style.left = `${Math.max(4, anchorRect.left)}px`;
  dropdown.style.width = `${Math.min(360, Math.max(260, anchorRect.width))}px`;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
