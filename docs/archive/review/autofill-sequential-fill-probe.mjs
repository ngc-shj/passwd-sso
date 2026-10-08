// Live probe for docs/archive/review/autofill-sequential-fill-plan.md (Sony Bank login).
//
// Writes the three login fields the way the extension does (focus, native
// value setter, input/change/keyup/blur) in three orders and prints what the
// page keeps. Run from the repo root with network access:
//   node docs/archive/review/autofill-sequential-fill-probe.mjs
// Observed 2026-10-08: sync → password empty; yield-0 and password-last → kept.
import { chromium } from "playwright";

const URL = "https://sonybank.jp/pages/db/dbca0100/input/";
const browser = await chromium.launch();
const page = await browser.newPage({ locale: "ja-JP" });
for (const mode of ["sync", "yield-0", "password-last"]) {
  await page.goto(URL, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("#loginPwd_inputPass", { timeout: 60000 });
  const out = await page.evaluate(async (mode) => {
    const set = (el, v) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      for (const t of ["input", "change"]) el.dispatchEvent(new Event(t, { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    const $ = (id) => document.getElementById(id);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    if (mode === "password-last") {
      set($("brchNum"), "123");
      set($("accountNum"), "4567890");
      set($("loginPwd_inputPass"), "dummy-pw");
    } else {
      set($("loginPwd_inputPass"), "dummy-pw");
      if (mode === "yield-0") await tick();
      set($("brchNum"), "123");
      if (mode === "yield-0") await tick();
      set($("accountNum"), "4567890");
    }
    await new Promise((r) => setTimeout(r, 500));
    document.body.click();
    await new Promise((r) => setTimeout(r, 300));
    return ["brchNum", "accountNum", "loginPwd_inputPass"].map((id) => `${id}=${$(id).value}`);
  }, mode);
  console.log(mode, JSON.stringify(out));
}
await browser.close();
