"use client";

const TAG_STYLE_ID = "tag-color-styles";
const tagColorRules = new Set<string>();
let cachedNonce: string | null | undefined;

function getNonce(): string | null {
  if (cachedNonce !== undefined) return cachedNonce;
  if (typeof document === "undefined") {
    cachedNonce = null;
    return cachedNonce;
  }
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="csp-nonce"]'
  );
  cachedNonce = meta?.content ?? null;
  return cachedNonce;
}

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
    const nonce = getNonce();
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
