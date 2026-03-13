// Event name constants — single source of truth for custom event names.
// Used by both dispatch helpers and event listeners (e.g., useSidebarData).
export const TEAM_DATA_CHANGED_EVENT = "team-data-changed";
export const VAULT_DATA_CHANGED_EVENT = "vault-data-changed";

export function notifyTeamDataChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TEAM_DATA_CHANGED_EVENT));
}

export function notifyVaultDataChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(VAULT_DATA_CHANGED_EVENT));
}
