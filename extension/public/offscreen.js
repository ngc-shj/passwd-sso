// Offscreen document for clipboard write and SW keepalive.
// Service workers cannot access the clipboard directly;
// this document provides a DOM context for execCommand("copy").

// ── Clipboard ──
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg.target !== "offscreen") return;
  if (msg.type === "clipboard-write") {
    // When text is empty (clipboard clear), use a space character.
    // execCommand("copy") is a no-op with empty selection, and
    // navigator.clipboard.writeText requires focus that offscreen docs lack.
    var text = msg.text || " ";
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    sendResponse({ ok: true });
  }
  if (msg.type === "start-keepalive") {
    startKeepalive();
    sendResponse({ ok: true });
  }
  if (msg.type === "stop-keepalive") {
    stopKeepalive();
    sendResponse({ ok: true });
  }
});

// ── SW Keepalive ──
// Pings the service worker every 25 seconds to prevent Chrome from
// terminating it during the 30-second idle timeout.
var keepaliveInterval = null;

function startKeepalive() {
  if (keepaliveInterval) return;
  keepaliveInterval = setInterval(function () {
    chrome.runtime.sendMessage({ type: "KEEPALIVE_PING" });
  }, 25000);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}
