/**
 * Lightweight server-side User-Agent parser.
 * Returns a short human-readable device string like "macOS (Chrome)".
 */

function detectOS(ua: string): string {
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  if (ua.includes("Mac OS X") || ua.includes("Macintosh")) return "macOS";
  if (ua.includes("CrOS")) return "ChromeOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  return "Unknown OS";
}

function detectBrowser(ua: string): string {
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/")) return "Safari";
  return "Browser";
}

export function parseDeviceFromUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  return `${detectOS(ua)} (${detectBrowser(ua)})`;
}
