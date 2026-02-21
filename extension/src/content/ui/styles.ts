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
