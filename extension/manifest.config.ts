import { defineManifest } from "@crxjs/vite-plugin";
import rootPkg from "../package.json";
import {
  CMD_TRIGGER_AUTOFILL,
  CMD_COPY_PASSWORD,
  CMD_COPY_USERNAME,
  CMD_LOCK_VAULT,
} from "./src/lib/constants";

export default defineManifest({
  manifest_version: 3,
  name: "__MSG_extName__",
  version: rootPkg.version,
  description: "__MSG_extDescription__",
  default_locale: "en",
  // asyncBlocking on webRequest.onAuthRequired in MV3 is supported from Chrome
  // 120 (MDN browser-compat for onAuthRequired extraInfoSpec "asyncBlocking";
  // Chrome's own reference lists only the MV2-era "58+"). HTTP auth (#905)
  // registers that listener, so this is the floor.
  minimum_chrome_version: "120",
  permissions: ["storage", "alarms", "activeTab", "scripting", "contextMenus", "clipboardWrite", "offscreen"],
  // HTTP auth (#905) asks for these per site from the popup. Optional, so the
  // install and update prompts do not change; never move them into
  // `permissions`.
  optional_permissions: ["webRequest", "webRequestAuthProvider"],
  optional_host_permissions: ["https://*/*", "http://localhost/*", "http://*/*"],
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
      // X/F are unassigned in Edge and Chrome on all platforms; the previous
      // A/P/U defaults collided with Edge built-ins (tab search, system
      // print, read aloud). Copy commands ship unset — users can bind them
      // at chrome://extensions/shortcuts (edge://extensions/shortcuts).
      suggested_key: {
        default: "Ctrl+Shift+X",
        mac: "Command+Shift+X",
      },
      description: "__MSG_cmdOpenPopup__",
    },
    [CMD_COPY_PASSWORD]: {
      description: "__MSG_cmdCopyPassword__",
    },
    [CMD_COPY_USERNAME]: {
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
      resources: ["src/content/token-bridge.js", "src/content/webauthn-interceptor.js"],
      matches: ["https://*/*", "http://localhost/*"],
    },
  ],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  icons: {
    "16": "public/icons/icon-16.png",
    "48": "public/icons/icon-48.png",
    "128": "public/icons/icon-128.png",
  },
});
