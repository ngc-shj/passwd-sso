// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: autofill-lib.ts (for tests).

function setInputValue(input, value) {
  input.focus();
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
  // Legacy forms often validate on keyup/blur handlers.
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

function isUsableInput(input) {
  return !input.disabled && !input.readOnly;
}

function escapeSelectorValue(value) {
  var esc = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape : null;
  if (esc) return esc(value);
  return value.replace(/["\\]/g, "\\$&");
}

function findPasswordInput(inputs) {
  var isVisible = function (input) {
    return (
      getComputedStyle(input).display !== "none" &&
      getComputedStyle(input).visibility !== "hidden"
    );
  };

  var byAutocomplete = inputs.find(function (i) {
    return (
      isUsableInput(i) &&
      i.type === "password" &&
      isVisible(i) &&
      i.autocomplete === "current-password"
    );
  });
  if (byAutocomplete) return byAutocomplete;
  var passwordInputs = inputs.filter(function (i) {
    return isUsableInput(i) && i.type === "password" && isVisible(i);
  });
  return passwordInputs.length > 0
    ? passwordInputs[passwordInputs.length - 1]
    : null;
}

function findUsernameInput(inputs, passwordInput) {
  var isUsernameLike = function (candidate) {
    if (!isUsableInput(candidate)) return false;
    if (["text", "email", "tel"].indexOf(candidate.type) === -1) return false;

    var ac = (candidate.autocomplete || "").toLowerCase().trim();
    if (ac === "username" || ac === "email") return true;
    if (ac.indexOf("one-time-code") !== -1 || ac.indexOf("password") !== -1)
      return false;

    var hints = [
      candidate.name,
      candidate.id,
      candidate.placeholder,
      candidate.getAttribute("formcontrolname"),
      candidate.getAttribute("ng-reflect-name"),
      candidate.getAttribute("aria-label"),
      candidate.getAttribute("aria-labelledby"),
      (candidate.closest("label") || {}).textContent || "",
      (function () {
        var id = candidate.id;
        if (!id) return "";
        return (
          (
            (
              document.querySelector(
                'label[for="' + escapeSelectorValue(id) + '"]'
              ) || {}
            ).textContent
          ) || ""
        );
      })(),
    ]
      .filter(function (v) {
        return Boolean(v && v.trim());
      })
      .join(" ")
      .toLowerCase();

    if (!hints) return false;
    if (
      /\b(search|query|keyword|coupon|promo|otp|code|verification)\b/.test(
        hints
      ) ||
      /(検索|クーポン|認証コード|確認コード|ワンタイム)/.test(hints)
    ) {
      return false;
    }
    return (
      /\b(user(name)?|userid|login|email|e-?mail|identifier|account|member|id|contract|customer)\b/.test(
        hints
      ) ||
      /(ログイン|ユーザー|メール|アカウント|会員|契約番号|ご契約番号|お客さま番号|顧客番号|店番|口座番号)/.test(
        hints
      )
    );
  };

  var byAutocomplete = inputs.find(function (i) {
    return (
      isUsableInput(i) &&
      (i.type === "text" || i.type === "email" || i.type === "tel") &&
      i.autocomplete === "username"
    );
  });
  if (byAutocomplete) return byAutocomplete;

  if (!passwordInput) return null;
  var index = inputs.indexOf(passwordInput);
  if (index <= 0) return null;
  for (var i = index - 1; i >= 0; i -= 1) {
    var candidate = inputs[i];
    if (isUsernameLike(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findFocusedTextInput() {
  var active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  if (!isUsableInput(active)) return null;
  if (["text", "email", "tel"].indexOf(active.type) === -1) return null;
  return active;
}

function getHints(input) {
  var id = input.id;
  var label =
    (id
      ? (
          document.querySelector(
            'label[for="' + escapeSelectorValue(id) + '"]'
          ) || {}
        ).textContent || ""
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
  var hintedInput =
    (payload.targetHint && payload.targetHint.id
      ? inputs.find(function (i) {
          return i.id === payload.targetHint.id;
        })
      : undefined) ||
    (payload.targetHint && payload.targetHint.name
      ? inputs.find(function (i) {
          return i.name === payload.targetHint.name;
        })
      : undefined) ||
    (payload.targetHint && payload.targetHint.autocomplete
      ? inputs.find(function (i) {
          return (
            i.autocomplete === payload.targetHint.autocomplete &&
            (!payload.targetHint.type || i.type === payload.targetHint.type)
          );
        })
      : undefined) ||
    null;
  var hintedUsernameInput =
    hintedInput &&
    isUsableInput(hintedInput) &&
    ["text", "email", "tel"].indexOf(hintedInput.type) !== -1
      ? hintedInput
      : null;

  var focusedUsername = findFocusedTextInput();
  var scopeForm = (focusedUsername || hintedUsernameInput)
    ? (focusedUsername || hintedUsernameInput).form
    : null;
  var passwordInput =
    (scopeForm
      ? findPasswordInput(Array.from(scopeForm.querySelectorAll("input")))
      : null) || findPasswordInput(inputs);
  var usernameInput =
    focusedUsername ||
    hintedUsernameInput ||
    findUsernameInput(inputs, passwordInput);

  var host = window.location.hostname.toLowerCase();
  var isAwsSignInPage =
    host === "signin.aws.amazon.com" ||
    host.endsWith(".signin.aws.amazon.com") ||
    host === "sign-in.aws.amazon.com" ||
    host.endsWith(".sign-in.aws.amazon.com");

  var findAwsAccountInput = function () {
    return (
      inputs.find(function (i) {
        if (
          !isUsableInput(i) ||
          ["text", "email", "tel"].indexOf(i.type) === -1
        )
          return false;
        return /(account|alias|アカウント|エイリアス)/.test(getHints(i));
      }) || null
    );
  };

  var findAwsIamInput = function () {
    return (
      inputs.find(function (i) {
        if (
          !isUsableInput(i) ||
          ["text", "email", "tel"].indexOf(i.type) === -1
        )
          return false;
        return /(iam|username|user.?name|ユーザー名|ユーザ名)/.test(
          getHints(i)
        );
      }) || null
    );
  };

  if (isAwsSignInPage) {
    var awsAccountInput = findAwsAccountInput();
    var awsIamInput = findAwsIamInput();
    if (awsAccountInput && payload.awsAccountIdOrAlias) {
      setInputValue(awsAccountInput, payload.awsAccountIdOrAlias);
    }
    if (awsIamInput && (payload.awsIamUsername || payload.username)) {
      setInputValue(awsIamInput, payload.awsIamUsername || payload.username);
    }
  }

  var hasAwsSpecificValues =
    isAwsSignInPage &&
    Boolean(payload.awsAccountIdOrAlias || payload.awsIamUsername);

  if (!hasAwsSpecificValues && usernameInput && payload.username) {
    setInputValue(usernameInput, payload.username);
  }
  if (passwordInput && payload.password) {
    setInputValue(passwordInput, payload.password);
  }

  if (payload.totpCode) {
    var otpForm = (passwordInput && passwordInput.form) || scopeForm || null;
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

// Guard against double-registration when injected multiple times.
var AUTOFILL_GUARD = "__pssoAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.onMessage &&
  !window[AUTOFILL_GUARD]
) {
  window[AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "AUTOFILL_FILL") {
      performAutofill(message);
    }
  });
}
