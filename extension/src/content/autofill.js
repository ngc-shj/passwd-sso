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

// Indexed name pattern for split OTP fields: "otp-code-0", "2fa-3", etc.
// Keywords aligned with otpHintRe in findOtpInput.
var indexedOtpNameRe =
  /^(otp|totp|2fa|two[-_]?factor|mfa|verification[-_]?code|security[-_]?code|auth(?:entication)?[-_]?code|one[-_]?time|otp[-_]?code)[-_]?\d+$/i;

function isSingleDigitOtp(input) {
  if (!isUsableInput(input)) return false;
  if (["text", "tel"].indexOf(input.type) === -1) return false;
  var ml = input.maxLength;
  if (ml === 1) return true;
  // Detect by indexed name (e.g. "otp-code-0" … "otp-code-5")
  return indexedOtpNameRe.test(input.name);
}

function findSplitOtpInputs(inputs, codeLength) {
  for (var start = 0; start <= inputs.length - codeLength; start++) {
    var candidate = inputs[start];
    if (!isSingleDigitOtp(candidate)) continue;

    var group = [candidate];
    var parent =
      candidate.parentElement
        ? candidate.parentElement.closest(
            "form, fieldset, [role='group'], section"
          )
        : null;
    for (
      var j = start + 1;
      j < inputs.length && group.length < codeLength;
      j++
    ) {
      var next = inputs[j];
      if (!isSingleDigitOtp(next)) break;
      var nextParent =
        next.parentElement
          ? next.parentElement.closest(
              "form, fieldset, [role='group'], section"
            )
          : null;
      if (!parent || !nextParent) break;
      if (parent !== nextParent) {
        var shared = false;
        var el = next;
        for (var depth = 0; depth < 5 && el; depth++) {
          if (el === parent) {
            shared = true;
            break;
          }
          el = el.parentElement;
        }
        if (!shared) break;
      }
      group.push(next);
    }
    if (group.length === codeLength) return group;
  }
  return null;
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

  // Build label→input map for custom fields and identify reserved inputs
  var customFieldMap = {};
  var customFieldTargetSet = [];
  if (payload.customFields) {
    for (var cfIdx = 0; cfIdx < payload.customFields.length; cfIdx++) {
      var cfLabel = payload.customFields[cfIdx].label;
      var lower = cfLabel.toLowerCase();
      var target = inputs.find(function (i) {
        return (
          isUsableInput(i) &&
          i.type !== "password" &&
          (i.id.toLowerCase() === lower || i.name.toLowerCase() === lower)
        );
      });
      if (target) {
        customFieldMap[lower] = target;
        if (customFieldTargetSet.indexOf(target) === -1) {
          customFieldTargetSet.push(target);
        }
      }
    }
  }

  var isCustomFieldTarget = function (input) {
    return customFieldTargetSet.indexOf(input) !== -1;
  };

  var focusedUsername = findFocusedTextInput();
  // If focused input is reserved for a custom field, don't use it as username target
  var effectiveFocusedUsername =
    focusedUsername && !isCustomFieldTarget(focusedUsername) ? focusedUsername : null;
  var effectiveHintedUsername =
    hintedUsernameInput && !isCustomFieldTarget(hintedUsernameInput) ? hintedUsernameInput : null;

  var scopeForm = (effectiveFocusedUsername || effectiveHintedUsername || focusedUsername || hintedUsernameInput)
    ? (effectiveFocusedUsername || effectiveHintedUsername || focusedUsername || hintedUsernameInput).form
    : null;
  var passwordInput =
    (scopeForm
      ? findPasswordInput(Array.from(scopeForm.querySelectorAll("input")))
      : null) || findPasswordInput(inputs);
  var usernameInput =
    effectiveFocusedUsername ||
    effectiveHintedUsername ||
    findUsernameInput(
      inputs.filter(function (i) { return !isCustomFieldTarget(i); }),
      passwordInput
    );

  if (usernameInput && payload.username) {
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

    // Try split OTP fields first (e.g. 6 separate single-digit inputs)
    var codeLen = payload.totpCode.length;
    var splitInputs =
      (otpScopedInputs ? findSplitOtpInputs(otpScopedInputs, codeLen) : null) ||
      findSplitOtpInputs(inputs, codeLen);
    if (splitInputs) {
      for (var idx = 0; idx < codeLen; idx++) {
        setInputValue(splitInputs[idx], payload.totpCode[idx]);
      }
    } else {
      // Fall back to single OTP field
      var otpInput =
        (otpScopedInputs ? findOtpInput(otpScopedInputs) : null) ||
        findOtpInput(inputs);
      if (otpInput) {
        setInputValue(otpInput, payload.totpCode);
      }
    }
  }

  // Generic custom field autofill using pre-built label→input map
  if (payload.customFields) {
    for (var cfFillIdx = 0; cfFillIdx < payload.customFields.length; cfFillIdx++) {
      var cf = payload.customFields[cfFillIdx];
      var cfTarget = customFieldMap[cf.label.toLowerCase()];
      if (cfTarget) {
        setInputValue(cfTarget, cf.value);
      }
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
  chrome.runtime.onMessage.addListener(function (message, sender) {
    // Only accept messages from our own extension — reject external senders
    if (message && message.type === "AUTOFILL_FILL" && sender.id === chrome.runtime.id) {
      performAutofill(message);
    }
  });
}
