// Offscreen document for clipboard write operations.
// Service workers cannot access the clipboard directly;
// this document provides a DOM context for execCommand("copy").
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg.target !== "offscreen") return;
  if (msg.type === "clipboard-write") {
    var ta = document.createElement("textarea");
    ta.value = msg.text || "";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    sendResponse({ ok: true });
  }
});
