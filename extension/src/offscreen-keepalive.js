// Offscreen document keepalive — pings the service worker every 25 seconds
// to prevent Chrome from terminating it during the 30-second idle timeout.
// Created when vault is unlocked, closed on vault lock or token clear.

setInterval(function () {
  chrome.runtime.sendMessage({ type: "KEEPALIVE_PING" });
}, 25000);
