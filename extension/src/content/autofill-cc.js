// Content script entry point for credit card autofill — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: autofill-cc-lib.ts (for tests).

function isFieldVisible(el) {
  var style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function setInputValue(input, value) {
  if (!isFieldVisible(input)) return;
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
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

// Month name normalization for select matching
var MONTH_NAMES = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  "1月": "01", "2月": "02", "3月": "03", "4月": "04",
  "5月": "05", "6月": "06", "7月": "07", "8月": "08",
  "9月": "09", "10月": "10", "11月": "11", "12月": "12"
};

function normalizeMonthValue(value) {
  var lower = value.toLowerCase().trim();
  if (MONTH_NAMES[lower]) return MONTH_NAMES[lower];
  var num = parseInt(lower, 10);
  if (!isNaN(num) && num >= 1 && num <= 12) return String(num).padStart(2, "0");
  return lower;
}

function normalizeYearValue(value) {
  var trimmed = value.trim();
  var num = parseInt(trimmed, 10);
  if (isNaN(num)) return trimmed;
  return String(num);
}

function setSelectValue(select, targetValue, normalizer) {
  if (!isFieldVisible(select)) return;
  var normalizedTarget = normalizer(targetValue);
  var options = Array.from(select.options);
  var match = null;
  for (var i = 0; i < options.length; i++) {
    if (normalizer(options[i].value) === normalizedTarget) {
      match = options[i];
      break;
    }
  }
  if (!match) {
    for (var j = 0; j < options.length; j++) {
      if (normalizer((options[j].textContent || "").trim()) === normalizedTarget) {
        match = options[j];
        break;
      }
    }
  }
  if (!match) {
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[passwd-sso] No exact match for select value: " + targetValue);
    }
    return;
  }
  var setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value"
  );
  if (setter && setter.set) {
    setter.set.call(select, match.value);
  } else {
    select.value = match.value;
  }
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function getHintString(el) {
  var parts = [];
  if (el.name) parts.push(el.name);
  if (el.id) parts.push(el.id);
  if (el.placeholder) parts.push(el.placeholder);
  if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
  var elId = el.id;
  if (elId && typeof CSS !== "undefined" && CSS.escape) {
    var label = document.querySelector('label[for="' + CSS.escape(elId) + '"]');
    if (label && label.textContent) parts.push(label.textContent);
  }
  var parentLabel = el.closest("label");
  if (parentLabel && parentLabel.textContent) parts.push(parentLabel.textContent);
  return parts.join(" ").toLowerCase();
}

function getAutocomplete(el) {
  return (el.getAttribute("autocomplete") || "").toLowerCase().trim();
}

function isUsableField(el) {
  return !el.disabled && !(el.readOnly && el instanceof HTMLInputElement);
}

function findFieldByAC(fields, acValue) {
  for (var i = 0; i < fields.length; i++) {
    if (getAutocomplete(fields[i]) === acValue && isUsableField(fields[i])) return fields[i];
  }
  return null;
}

function findFieldByRegex(fields, regex, regexJa) {
  for (var i = 0; i < fields.length; i++) {
    if (!isUsableField(fields[i])) continue;
    var hint = getHintString(fields[i]);
    if (regex.test(hint) || regexJa.test(hint)) return fields[i];
  }
  return null;
}

function detectExpiryFormat(el) {
  var placeholder = (el.placeholder || "").toUpperCase();
  if (placeholder.indexOf("MM/YYYY") !== -1 || placeholder.indexOf("MM / YYYY") !== -1) return "MM/YYYY";
  if (placeholder.indexOf("MM/YY") !== -1 || placeholder.indexOf("MM / YY") !== -1) return "MM/YY";
  if (placeholder.indexOf("MMYYYY") !== -1) return "MMYYYY";
  if (placeholder.indexOf("MMYY") !== -1) return "MMYY";
  var ml = el.maxLength;
  if (ml === 7) return "MM/YYYY";
  if (ml === 5) return "MM/YY";
  if (ml === 6) return "MMYYYY";
  if (ml === 4) return "MMYY";
  return "MM/YY";
}

function formatCombinedExpiry(month, year, format) {
  var mm = month.length < 2 ? "0" + month : month;
  var yy = year.length > 2 ? year.slice(-2) : (year.length < 2 ? "0" + year : year);
  var yyyy = year.length === 4 ? year : "20" + yy;
  if (format === "MM/YY") return mm + "/" + yy;
  if (format === "MM/YYYY") return mm + "/" + yyyy;
  if (format === "MMYY") return mm + yy;
  if (format === "MMYYYY") return mm + yyyy;
  return mm + "/" + yy;
}

function performCreditCardAutofill(payload) {
  var inputs = Array.from(document.querySelectorAll("input"));
  var selects = Array.from(document.querySelectorAll("select"));
  var allFields = inputs.concat(selects);
  var visibleFields = allFields.filter(function (f) {
    return isFieldVisible(f) && isUsableField(f);
  });

  var ccNumRe = /card.?num|cc.?num|pan/i;
  var ccNumJa = /カード番号/;
  var ccNameRe = /card.?holder|cc.?name|name.?on.?card/i;
  var ccNameJa = /名義|カード名義/;
  var ccExpRe = /expir|exp.?date|valid.?thru|card.?exp/i;
  var ccExpJa = /有効期限/;
  var ccExpMonthRe = /exp.?month|cc.?exp.?month|card.?month/i;
  var ccExpMonthJa = /月/;
  var ccExpYearRe = /exp.?year|cc.?exp.?year|card.?year/i;
  var ccExpYearJa = /年/;
  var ccCvvRe = /cvv|cvc|csc|cv2|security.?code|card.?code/i;
  var ccCvvJa = /セキュリティコード/;

  var cardNumber = findFieldByAC(visibleFields, "cc-number") || findFieldByRegex(visibleFields, ccNumRe, ccNumJa);
  var cardholderName = findFieldByAC(visibleFields, "cc-name") || findFieldByRegex(visibleFields, ccNameRe, ccNameJa);
  var cvv = findFieldByAC(visibleFields, "cc-csc") || findFieldByRegex(visibleFields, ccCvvRe, ccCvvJa);
  var expiryCombined = findFieldByAC(visibleFields, "cc-exp");
  var expiryMonth = findFieldByAC(visibleFields, "cc-exp-month");
  var expiryYear = findFieldByAC(visibleFields, "cc-exp-year");

  if (!expiryMonth && !expiryCombined) {
    var combined = findFieldByRegex(visibleFields, ccExpRe, ccExpJa);
    if (combined && combined instanceof HTMLInputElement) {
      expiryCombined = combined;
    } else {
      expiryMonth = findFieldByRegex(visibleFields, ccExpMonthRe, ccExpMonthJa);
    }
  }
  if (!expiryYear && !expiryCombined) {
    expiryYear = findFieldByRegex(visibleFields, ccExpYearRe, ccExpYearJa);
  }

  if (!cardNumber) return;

  if (cardholderName && payload.cardholderName) {
    setInputValue(cardholderName, payload.cardholderName);
  }
  if (cardNumber && payload.cardNumber) {
    setInputValue(cardNumber, payload.cardNumber);
  }

  if (expiryCombined && expiryCombined instanceof HTMLInputElement) {
    var fmt = detectExpiryFormat(expiryCombined);
    var val = formatCombinedExpiry(payload.expiryMonth, payload.expiryYear, fmt);
    setInputValue(expiryCombined, val);
  } else {
    if (expiryMonth && payload.expiryMonth) {
      if (expiryMonth instanceof HTMLSelectElement) {
        setSelectValue(expiryMonth, payload.expiryMonth, normalizeMonthValue);
      } else {
        setInputValue(expiryMonth, payload.expiryMonth);
      }
    }
    if (expiryYear && payload.expiryYear) {
      if (expiryYear instanceof HTMLSelectElement) {
        setSelectValue(expiryYear, payload.expiryYear, normalizeYearValue);
      } else {
        setInputValue(expiryYear, payload.expiryYear);
      }
    }
  }

  if (cvv && payload.cvv) {
    setInputValue(cvv, payload.cvv);
    payload.cvv = "";
  }
}

// Guard against double-registration
var CC_AUTOFILL_GUARD = "__pssoCCAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.onMessage &&
  !window[CC_AUTOFILL_GUARD]
) {
  window[CC_AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "AUTOFILL_CC_FILL") {
      performCreditCardAutofill(message);
    }
  });
}
