"use client";

import { readCspNonce } from "./csp-nonce";

const TAG_STYLE_ID = "tag-color-styles";
const tagColorRules = new Set<string>();

function ensureTagStyleElement(nonce: string | null): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  let style = document.getElementById(TAG_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = TAG_STYLE_ID;
    if (nonce) style.setAttribute("nonce", nonce);
    document.head.appendChild(style);
  } else if (nonce && !style.getAttribute("nonce")) {
    style.setAttribute("nonce", nonce);
  }
  return style;
}

export function getTagColorClass(color: string | null): string | null {
  if (!color) return null;
  const normalized = color.toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) return null;

  const className = `tag-color-${normalized.slice(1)}`;
  if (typeof document === "undefined") return className;

  if (!tagColorRules.has(className)) {
    const nonce = readCspNonce();
    const style = ensureTagStyleElement(nonce);
    if (style) {
      style.appendChild(
        document.createTextNode(`.${className}{--tag-color:${normalized};}\n`)
      );
      tagColorRules.add(className);
    }
  }

  return className;
}
