/**
 * @vitest-environment jsdom
 */
// Sony Bank login (React 19 concurrent root, no <form>), modelled on the live
// component tree: each field shows local state set synchronously in onChange, and
// hands the value to a form store whose update lands asynchronously
// (`c.setValue(t)`). onBlur writes the store's value back into the field
// (`r !== u.value && await c.setValue(r)`). Writing the password and focusing
// the next field in the same task therefore blurs the password while the store
// still holds "", and the field is reset.
//
// Real timers: the React scheduler runs on MessageChannel, which fake timers do not
// drive. Writes go through the real performAutofill, which dispatches raw native
// events — no act(), no fireEvent.
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { performAutofill } from "../../content/autofill-lib";
import { __resetFillSequenceForTests } from "../../content/fill-sequence-lib";
import type { AutofillPayload } from "../../types/messages";
import { AUTOFILL_FILL } from "../../lib/constants";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

function ControlledInput({ id, type, name }: { id: string; type: string; name?: string }) {
  const [display, setDisplay] = useState("");
  const [stored, setStored] = useState("");
  const storeValue = (value: string) => {
    void Promise.resolve().then(() => setStored(value));
  };
  return (
    <input
      id={id}
      type={type}
      name={name}
      value={display}
      onChange={(e) => {
        setDisplay(e.target.value);
        storeValue(e.target.value);
      }}
      onBlur={() => {
        setDisplay(stored);
        storeValue(stored);
      }}
    />
  );
}

function SonyLogin({ withAccountNum = true }: { withAccountNum?: boolean }) {
  return (
    <div className="ReactModalPortal">
      <div>
        <ControlledInput id="brchNum" type="text" />
      </div>
      {withAccountNum && (
        <div>
          <ControlledInput id="accountNum" type="text" />
        </div>
      )}
      <div>
        <ControlledInput id="loginPwd_inputPass" type="password" name="loginPwd" />
      </div>
    </div>
  );
}

let root: Root | null = null;

function mount(withAccountNum = true): void {
  const container = document.createElement("div");
  container.id = "__next";
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root?.render(<SonyLogin withAccountNum={withAccountNum} />));
}

afterEach(() => {
  __resetFillSequenceForTests();
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function $(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`fixture missing #${id}`);
  return el;
}

function payload(): AutofillPayload {
  return {
    type: AUTOFILL_FILL,
    username: "",
    password: "dummy-pw",
    customFields: [
      { label: "brchNum", value: "123" },
      { label: "accountNum", value: "4567890" },
    ],
  };
}

// The pre-fix write: the same helper sequence as the old synchronous
// performAutofill (password, then the custom fields, one task).
function writeSync(el: HTMLInputElement, value: string): void {
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

describe("performAutofill — React-controlled login (Sony Bank)", () => {
  it("precondition: the pre-fix synchronous order loses the password", async () => {
    mount();
    writeSync($("loginPwd_inputPass"), "dummy-pw");
    writeSync($("brchNum"), "123");
    writeSync($("accountNum"), "4567890");
    await settle();

    expect($("loginPwd_inputPass").value).toBe("");
  });

  it("keeps the password with the custom fields filled", async () => {
    mount();
    // The dropdown opened on 店番号, so the focused field is a custom-field target.
    $("brchNum").focus();

    await performAutofill(payload());
    await settle();

    expect($("brchNum").value).toBe("123");
    expect($("accountNum").value).toBe("4567890");
    expect($("loginPwd_inputPass").value).toBe("dummy-pw");
  });

  // A native listener on the password runs before React's root-delegated onChange,
  // so the late field is inserted (and observed) before the password's store update
  // is even queued. Writing it from the observer callback would blur the password
  // while the store still holds "".
  it("writes a custom field created by the password write, from its own task", async () => {
    mount(false);
    const password = $("loginPwd_inputPass");
    password.addEventListener(
      "input",
      () => {
        const late = document.createElement("input");
        late.id = "accountNum";
        late.type = "text";
        password.parentElement?.before(late);
      },
      { once: true },
    );
    $("brchNum").focus();

    await performAutofill(payload());
    await settle();

    expect($("accountNum").value).toBe("4567890");
    expect(password.value).toBe("dummy-pw");
  });
});
