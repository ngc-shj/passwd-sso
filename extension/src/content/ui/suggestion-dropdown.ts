// Floating suggestion dropdown for inline autofill.
// Rendered inside a closed Shadow DOM to isolate styles.

import type { DecryptedEntry } from "../../types/messages";
import { getShadowHost } from "./shadow-host";
import { DROPDOWN_STYLES } from "./styles";
import { KEY_ICON, LOCK_ICON, USER_ICON } from "./icons";

export interface DropdownOptions {
  anchorRect: DOMRect;
  entries: DecryptedEntry[];
  vaultLocked: boolean;
  onSelect: (entryId: string) => void;
  onDismiss: () => void;
  lockedMessage: string;
  noMatchesMessage: string;
  headerLabel: string;
}

let currentDropdown: HTMLDivElement | null = null;
let activeIndex = -1;
let itemElements: HTMLDivElement[] = [];
let currentOnDismiss: (() => void) | null = null;
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;

function isSafeSelectClick(e: MouseEvent, item: HTMLDivElement): boolean {
  if (!e.isTrusted) return false;
  const topEl = document.elementFromPoint(e.clientX, e.clientY);
  return topEl === item || (topEl instanceof Node && item.contains(topEl));
}

export function showDropdown(opts: DropdownOptions): void {
  hideDropdown();

  const { root } = getShadowHost();

  const style = document.createElement("style");
  style.textContent = DROPDOWN_STYLES;
  root.appendChild(style);

  const dropdown = document.createElement("div");
  dropdown.className = "psso-dropdown";
  dropdown.style.pointerEvents = "auto";
  dropdown.setAttribute("role", "listbox");

  if (opts.vaultLocked) {
    const locked = document.createElement("div");
    locked.className = "psso-locked";
    locked.innerHTML = `${LOCK_ICON}<span>${escapeHtml(opts.lockedMessage)}</span>`;
    dropdown.appendChild(locked);
  } else if (opts.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "psso-empty";
    empty.textContent = opts.noMatchesMessage;
    dropdown.appendChild(empty);
  } else {
    const header = document.createElement("div");
    header.className = "psso-dropdown-header";
    header.textContent = opts.headerLabel;
    dropdown.appendChild(header);

    itemElements = [];
    activeIndex = -1;

    for (const entry of opts.entries) {
      const item = document.createElement("div");
      item.className = "psso-item";
      item.setAttribute("role", "option");
      item.setAttribute("data-entry-id", entry.id);

      item.innerHTML = `
        <div class="psso-item-icon">${KEY_ICON}</div>
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
          opts.onSelect(entry.id);
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

  // Click outside to dismiss (delayed to avoid triggering on the same click)
  requestAnimationFrame(() => {
    outsideClickHandler = (e: MouseEvent) => {
      const path = e.composedPath();
      if (!path.includes(dropdown)) {
        hideDropdown();
      }
    };
    document.addEventListener("mousedown", outsideClickHandler, true);
  });
}

export function hideDropdown(): void {
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
}

export function isDropdownVisible(): boolean {
  return currentDropdown !== null;
}

export function handleDropdownKeydown(e: KeyboardEvent): boolean {
  if (!currentDropdown || itemElements.length === 0) return false;

  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      setActiveItem(activeIndex < itemElements.length - 1 ? activeIndex + 1 : 0);
      return true;
    }
    case "ArrowUp": {
      e.preventDefault();
      setActiveItem(activeIndex > 0 ? activeIndex - 1 : itemElements.length - 1);
      return true;
    }
    case "Enter": {
      if (activeIndex >= 0 && activeIndex < itemElements.length) {
        e.preventDefault();
        const entryId = itemElements[activeIndex].getAttribute("data-entry-id");
        if (entryId) {
          // Find the onSelect callback via a synthetic mousedown
          itemElements[activeIndex].dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true }),
          );
        }
        return true;
      }
      return false;
    }
    case "Escape": {
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
