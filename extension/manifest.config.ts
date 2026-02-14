import { defineManifest } from "@crxjs/vite-plugin";
import { CMD_TRIGGER_AUTOFILL } from "./src/lib/constants";

export default defineManifest({
  manifest_version: 3,
  name: "passwd-sso",
  version: "0.1.0",
  description: "Browser extension for passwd-sso password manager",
  permissions: ["storage", "alarms", "activeTab", "scripting"],
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
        default: "Ctrl+Shift+L",
        mac: "Command+Shift+L",
      },
      description: "Open passwd-sso popup",
    },
    [CMD_TRIGGER_AUTOFILL]: {
      suggested_key: {
        default: "Ctrl+Shift+F",
        mac: "Command+Shift+F",
      },
      description: "Autofill current page",
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
