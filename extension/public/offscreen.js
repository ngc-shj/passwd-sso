// Offscreen document for clipboard write operations.
// Service workers cannot access the clipboard directly;
// this document provides a DOM context for execCommand("copy").
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
});
