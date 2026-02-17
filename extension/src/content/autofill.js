// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: autofill-lib.ts (for tests).

function setInputValue(input, value) {
  var setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  );
  if (setter && setter.set) {
    setter.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function isUsableInput(input) {
  return !input.disabled && !input.readOnly;
}

function findPasswordInput(inputs) {
  var byAutocomplete = inputs.find(function (i) {
    return (
      isUsableInput(i) &&
      i.type === "password" &&
      i.autocomplete === "current-password"
    );
  });
  if (byAutocomplete) return byAutocomplete;
  var passwordInputs = inputs.filter(function (i) {
    return isUsableInput(i) && i.type === "password";
  });
  return passwordInputs.length > 0
    ? passwordInputs[passwordInputs.length - 1]
    : null;
}

function findUsernameInput(inputs, passwordInput) {
  var byAutocomplete = inputs.find(function (i) {
    return (
      isUsableInput(i) &&
      (i.type === "text" || i.type === "email") &&
      i.autocomplete === "username"
    );
  });
  if (byAutocomplete) return byAutocomplete;

  if (!passwordInput) return null;
  var index = inputs.indexOf(passwordInput);
  if (index <= 0) return null;
  for (var i = index - 1; i >= 0; i -= 1) {
    var candidate = inputs[i];
    if (
      isUsableInput(candidate) &&
      (candidate.type === "text" || candidate.type === "email")
    ) {
      return candidate;
    }
  }
  return null;
}

function escapeSelectorValue(value) {
  return value.replace(/["\\]/g, "\\$&");
}

function getHints(input) {
  var id = input.id;
  var label =
    (id
      ? (document.querySelector('label[for="' + escapeSelectorValue(id) + '"]') || {}).textContent || ""
      : "") +
    (input.getAttribute("aria-label") || "") +
    (input.placeholder || "") +
    (input.name || "") +
    (input.id || "") +
    (input.getAttribute("formcontrolname") || "");
  return label.toLowerCase();
}

function findOtpInput(inputs) {
  var byAutocomplete = inputs.find(function (i) {
    return isUsableInput(i) && i.autocomplete === "one-time-code";
  });
  if (byAutocomplete) return byAutocomplete;

  var otpHintRe =
    /(otp|totp|2fa|two.?factor|mfa|verification.?code|security.?code|auth(?:entication)?.?code|one.?time)/i;
  var otpHintJaRe = /(認証コード|確認コード|ワンタイム|二段階|セキュリティコード)/;

  return (
    inputs.find(function (i) {
      if (!isUsableInput(i)) return false;
      if (["text", "tel", "number"].indexOf(i.type) === -1) return false;
      var hints = getHints(i);
      return otpHintRe.test(hints) || otpHintJaRe.test(hints);
    }) || null
  );
}

function performAutofill(payload) {
  var inputs = Array.from(document.querySelectorAll("input"));
  var passwordInput = findPasswordInput(inputs);
  var usernameInput = findUsernameInput(inputs, passwordInput);

  if (usernameInput && payload.username) {
    setInputValue(usernameInput, payload.username);
  }
  if (passwordInput) {
    setInputValue(passwordInput, payload.password);
  }

  if (payload.totpCode) {
    var otpForm = (passwordInput && passwordInput.form) || null;
    var otpScopedInputs = otpForm
      ? Array.from(otpForm.querySelectorAll("input"))
      : null;
    var otpInput =
      (otpScopedInputs ? findOtpInput(otpScopedInputs) : null) ||
      findOtpInput(inputs);
    if (otpInput) {
      setInputValue(otpInput, payload.totpCode);
    }
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "AUTOFILL_FILL") {
      performAutofill(message);
    }
  });
}
