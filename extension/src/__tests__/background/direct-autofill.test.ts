/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { directAutofill } from "../../background/direct-autofill";

afterEach(() => {
  document.body.innerHTML = "";
});

function $(selector: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`fixture missing ${selector}`);
  return el;
}

function logInputs(log: string[]): void {
  for (const el of document.querySelectorAll("input")) {
    el.addEventListener("input", () => log.push(el.id));
  }
}

// Sony Bank login shape: no <form>, two custom ID fields, then the password.
const SONY_SHAPE = `
  <input id="brchNum" type="text">
  <input id="accountNum" type="text">
  <input id="loginPwd_inputPass" type="password" name="loginPwd">
`;

const CUSTOM_FIELDS = [
  { label: "brchNum", value: "123" },
  { label: "accountNum", value: "4567890" },
];

describe("directAutofill", () => {
  it("writes custom fields, then the password, one field per task", async () => {
    document.body.innerHTML = SONY_SHAPE;
    const log: string[] = [];
    logInputs(log);
    // A task queued by the first write runs before the second write only if the
    // fill yields a macrotask between fields.
    $("#brchNum").addEventListener("input", () => setTimeout(() => log.push("task"), 0), {
      once: true,
    });

    await directAutofill("", "pw", null, CUSTOM_FIELDS);

    expect(log).toEqual(["brchNum", "task", "accountNum", "loginPwd_inputPass"]);
    expect($("#brchNum").value).toBe("123");
    expect($("#accountNum").value).toBe("4567890");
    expect($("#loginPwd_inputPass").value).toBe("pw");
  });

  it("does not write a target the page detached during a yield", async () => {
    document.body.innerHTML = SONY_SHAPE;
    const account = $("#accountNum");
    $("#brchNum").addEventListener("input", () => account.remove(), { once: true });

    await directAutofill("", "pw", null, CUSTOM_FIELDS);

    expect(account.value).toBe("");
    expect($("#loginPwd_inputPass").value).toBe("pw");
  });

  it("does not write a target whose type the page changed during a yield", async () => {
    document.body.innerHTML = SONY_SHAPE;
    const password = $("#loginPwd_inputPass");
    $("#accountNum").addEventListener("input", () => (password.type = "text"), { once: true });

    await directAutofill("", "pw", null, CUSTOM_FIELDS);

    expect(password.value).toBe("");
  });

  it("does not write a target the page hid during a yield", async () => {
    document.body.innerHTML = SONY_SHAPE;
    const password = $("#loginPwd_inputPass");
    $("#accountNum").addEventListener("input", () => (password.style.display = "none"), {
      once: true,
    });

    await directAutofill("", "pw", null, CUSTOM_FIELDS);

    expect(password.value).toBe("");
  });

  it("does not write a custom field into a non-text input that matches its label", async () => {
    document.body.innerHTML = `
      <input id="secret" type="password">
      <input id="pin" type="hidden">
      <input id="user" type="text">
    `;

    await directAutofill("alice", "", null, [
      { label: "secret", value: "x" },
      { label: "pin", value: "y" },
    ]);

    expect($("#secret").value).toBe("");
    expect($("#pin").value).toBe("");
  });

  it("does not write a custom field into an invisible input", async () => {
    document.body.innerHTML = `<input id="brchNum" type="text" style="display:none">`;

    await directAutofill("", "", null, [{ label: "brchNum", value: "123" }]);

    expect($("#brchNum").value).toBe("");
  });

  it("chooses the text input when a non-text input earlier in the page shares the label", async () => {
    document.body.innerHTML = `
      <input name="pin" type="password">
      <input id="target" name="pin" type="text">
    `;

    await directAutofill("", "", null, [{ label: "pin", value: "123" }]);

    expect($("#target").value).toBe("123");
  });

  it("chooses the visible input when an invisible one earlier in the page shares the label", async () => {
    document.body.innerHTML = `
      <input name="pin" type="text" style="display:none">
      <input id="target" name="pin" type="text">
    `;

    await directAutofill("", "", null, [{ label: "pin", value: "123" }]);

    expect($("#target").value).toBe("123");
  });

  it("leaves the username to a custom field that reserved the same input", async () => {
    document.body.innerHTML = `
      <input id="brchNum" type="text">
      <input id="pw" type="password">
    `;

    await directAutofill("alice", "pw", null, [{ label: "brchNum", value: "123" }]);

    expect($("#brchNum").value).toBe("123");
    expect($("#pw").value).toBe("pw");
  });

  // executeScript runs the function from its source text in the page, where no
  // module scope exists. Rebuilding it from toString() fails on any import or
  // module-scope reference that the direct import above would hide.
  it("runs when rebuilt from its own source, as executeScript does", async () => {
    const serialized = new Function(`return (${directAutofill.toString()})`)() as typeof directAutofill;
    document.body.innerHTML = SONY_SHAPE;

    await serialized("", "pw", null, CUSTOM_FIELDS);

    expect($("#brchNum").value).toBe("123");
    expect($("#accountNum").value).toBe("4567890");
    expect($("#loginPwd_inputPass").value).toBe("pw");
  });
});
