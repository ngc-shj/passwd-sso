// Inline CSS for content script Shadow DOM UI.
// Tailwind is NOT used here — plain CSS keeps the bundle minimal.

export const DROPDOWN_STYLES = `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #1f2937;
  }
  .psso-dropdown {
    position: fixed;
    z-index: 2147483647;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    min-width: 260px;
    max-width: 360px;
    max-height: 300px;
    overflow-y: auto;
    padding: 4px 0;
  }
  .psso-dropdown-header {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid #e5e7eb;
  }
  .psso-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .psso-item:hover,
  .psso-item[data-active="true"] {
    background: #eff6ff;
  }
  .psso-item-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #dbeafe;
    border-radius: 6px;
    color: #2563eb;
  }
  .psso-item-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .psso-item-title {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .psso-item-username {
    font-size: 11px;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .psso-empty {
    padding: 12px;
    text-align: center;
    color: #9ca3af;
    font-size: 12px;
  }
  .psso-locked {
    padding: 12px;
    text-align: center;
    color: #d97706;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .psso-disconnected {
    padding: 12px;
    text-align: center;
    color: #6b7280;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
`;

/** Shared banner styles for top-of-page notification banners. */
export function bannerStyles(bannerId: string): string {
  return `
  #${bannerId} {
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
    animation: psso-slide-in 0.2s ease-out;
  }
  @keyframes psso-slide-in {
    from { transform: translateY(-100%); }
    to { transform: translateY(0); }
  }
  .psso-banner-message {
    flex: 1;
    min-width: 0;
  }
  .psso-banner-username {
    font-size: 11px;
    color: #94a3b8;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .psso-banner-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .psso-btn-primary,
  .psso-btn-secondary {
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    pointer-events: auto;
  }
  .psso-btn-primary {
    background: #3b82f6;
    color: #fff;
  }
  .psso-btn-primary:hover {
    background: #2563eb;
  }
  .psso-btn-secondary {
    background: #334155;
    color: #cbd5e1;
  }
  .psso-btn-secondary:hover {
    background: #475569;
  }
`;
}
