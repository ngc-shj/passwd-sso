// ── Extension ↔ Service Worker messages ──────────────────────

export type ExtensionMessage =
  | { type: "SET_TOKEN"; token: string; expiresAt: number }
  | { type: "GET_TOKEN" }
  | { type: "CLEAR_TOKEN" }
  | { type: "GET_STATUS" };

export type ExtensionResponse =
  | { type: "SET_TOKEN"; ok: true }
  | { type: "GET_TOKEN"; token: string | null }
  | { type: "CLEAR_TOKEN"; ok: true }
  | { type: "GET_STATUS"; hasToken: boolean; expiresAt: number | null };
