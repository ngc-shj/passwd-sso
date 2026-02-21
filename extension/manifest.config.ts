import { defineManifest } from "@crxjs/vite-plugin";
import {
  CMD_TRIGGER_AUTOFILL,
  CMD_COPY_PASSWORD,
  CMD_COPY_USERNAME,
  CMD_LOCK_VAULT,
} from "./src/lib/constants";

export default defineManifest({
  manifest_version: 3,
  name: "__MSG_extName__",
  version: "0.1.0",
  description: "__MSG_extDescription__",
  default_locale: "en",
  permissions: ["storage", "alarms", "activeTab", "scripting", "contextMenus", "clipboardWrite", "offscreen"],
  optional_host_permissions: ["https://*/*", "http://localhost/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      "16": "public/icons/icon-16.png",
      "48": "public/icons/icon-48.png",
      "128": "public/icons/icon-128.png",
    },
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  commands: {
    _execute_action: {
      suggested_key: {
        default: "Ctrl+Shift+A",
        mac: "Command+Shift+A",
      },
      description: "__MSG_cmdOpenPopup__",
    },
    [CMD_COPY_PASSWORD]: {
      suggested_key: {
        default: "Ctrl+Shift+P",
        mac: "Command+Shift+P",
      },
      description: "__MSG_cmdCopyPassword__",
    },
    [CMD_COPY_USERNAME]: {
      suggested_key: {
        default: "Ctrl+Shift+U",
        mac: "Command+Shift+U",
      },
      description: "__MSG_cmdCopyUsername__",
    },
    [CMD_LOCK_VAULT]: {
      description: "__MSG_cmdLockVault__",
    },
    [CMD_TRIGGER_AUTOFILL]: {
      suggested_key: {
        default: "Ctrl+Shift+F",
        mac: "Command+Shift+F",
      },
      description: "__MSG_cmdAutofill__",
    },
  },
  content_scripts: [
    {
      matches: ["https://*/*", "http://localhost/*"],
      js: ["src/content/form-detector.ts"],
      run_at: "document_idle",
      all_frames: true,
    },
  ],
  web_accessible_resources: [
    {
      resources: ["src/content/autofill.js", "src/content/token-bridge.js"],
      matches: ["https://*/*", "http://localhost/*"],
    },
  ],
  icons: {
    "16": "public/icons/icon-16.png",
    "48": "public/icons/icon-48.png",
    "128": "public/icons/icon-128.png",
  },
});
