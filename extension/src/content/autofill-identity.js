// Content script entry point for identity/address autofill — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: autofill-identity-lib.ts (for tests).

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

function setSelectValue(select, targetValue) {
  if (!isFieldVisible(select)) return;

  var normalizedTarget = targetValue.trim().toLowerCase();
  var options = Array.from(select.options);
  var match = null;

  // Exact match by value
  for (var i = 0; i < options.length; i++) {
    if (options[i].value.trim().toLowerCase() === normalizedTarget) {
      match = options[i];
      break;
    }
  }

  // Fallback: exact match by text content
  if (!match) {
    for (var j = 0; j < options.length; j++) {
      if ((options[j].textContent || "").trim().toLowerCase() === normalizedTarget) {
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

// Kana hint guard — a kana field's hint contains フリガナ/カナ/かな; combined with
// セイ/姓 (family) or メイ/名 (given). Plain 姓/名 fields must NOT match kana.
var KANA_RE = /フリガナ|カナ|かな/;

function findKanaField(fields, seiMeiRegex) {
  for (var i = 0; i < fields.length; i++) {
    if (!isUsableField(fields[i])) continue;
    var hint = getHintString(fields[i]);
    if (KANA_RE.test(hint) && seiMeiRegex.test(hint)) return fields[i];
  }
  return null;
}

function findPlainNameField(fields, regex, regexJa) {
  for (var i = 0; i < fields.length; i++) {
    if (!isUsableField(fields[i])) continue;
    var hint = getHintString(fields[i]);
    if (KANA_RE.test(hint)) continue;
    if (regex.test(hint) || regexJa.test(hint)) return fields[i];
  }
  return null;
}

function fillField(field, value) {
  if (!field || !value) return;
  if (field instanceof HTMLSelectElement) {
    setSelectValue(field, value);
  } else if (field instanceof HTMLInputElement) {
    setInputValue(field, value);
  }
}

function performIdentityAutofill(payload) {
  var inputs = Array.from(document.querySelectorAll("input"));
  var selects = Array.from(document.querySelectorAll("select"));
  var allFields = inputs.concat(selects);
  var visibleFields = allFields.filter(function (f) {
    return isFieldVisible(f) && isUsableField(f);
  });

  // Regex patterns
  var nameRe = /\b(full.?name|your.?name|first.?name|last.?name|name)\b/i;
  var nameJa = /氏名|お名前|名前|姓名/;
  var givenNameRe = /\b(first.?name|given.?name|forename)\b/i;
  var givenNameJa = /名/;
  var familyNameRe = /\b(last.?name|family.?name|surname)\b/i;
  var familyNameJa = /姓/;
  var kanaFamilyRe = /セイ|姓/;
  var kanaGivenRe = /メイ|名/;
  var addrRe = /\b(address|street|addr|address.?line|shipping.?address|billing.?address)\b/i;
  var addrJa = /住所|番地|丁目/;
  var addrLine2Re = /\b(address.?line.?2|apartment|apt|suite|unit|building)\b/i;
  var addrLine2Ja = /建物|部屋|号室|マンション/;
  var cityRe = /\b(city|town|locality|suburb)\b/i;
  var cityJa = /市区町村|市町村|区市町村/;
  var postalRe = /\b(zip|postal|post.?code|zip.?code)\b/i;
  var postalJa = /郵便番号/;
  var phoneRe = /\b(phone|tel|telephone|mobile|cell)\b/i;
  var phoneJa = /電話|携帯/;
  var emailRe = /\b(email|e.?mail)\b/i;
  var emailJa = /メール/;
  var dobRe = /\b(birth|dob|date.?of.?birth|birthday)\b/i;
  var dobJa = /生年月日|誕生日/;
  var regionRe = /\b(state|province|region|prefecture|county)\b/i;
  var regionJa = /都道府県|県/;
  var countryRe = /\b(country)\b/i;
  var countryJa = /国/;

  // Detect fields — autocomplete first, then regex fallback
  var fullName = findFieldByAC(visibleFields, "name") || findFieldByRegex(visibleFields, nameRe, nameJa);

  // Kana detected FIRST so it can't be mis-claimed by plain given/family.
  var familyNameKana = findKanaField(visibleFields, kanaFamilyRe);
  var givenNameKana = findKanaField(visibleFields, kanaGivenRe);

  var givenName = findFieldByAC(visibleFields, "given-name");
  if (!givenName) {
    var gn = findPlainNameField(visibleFields, givenNameRe, givenNameJa);
    givenName = gn === fullName ? null : gn;
  }
  var familyName = findFieldByAC(visibleFields, "family-name");
  if (!familyName) {
    var fn = findPlainNameField(visibleFields, familyNameRe, familyNameJa);
    familyName = fn === fullName ? null : fn;
  }
  var address = findFieldByAC(visibleFields, "address-line1") || findFieldByRegex(visibleFields, addrRe, addrJa);
  var addressLine2 = findFieldByAC(visibleFields, "address-line2") || findFieldByRegex(visibleFields, addrLine2Re, addrLine2Ja);
  var city = findFieldByAC(visibleFields, "address-level2") || findFieldByRegex(visibleFields, cityRe, cityJa);
  var postalCode = findFieldByAC(visibleFields, "postal-code") || findFieldByRegex(visibleFields, postalRe, postalJa);
  var phone = findFieldByAC(visibleFields, "tel") || findFieldByRegex(visibleFields, phoneRe, phoneJa);
  var email = findFieldByAC(visibleFields, "email") || findFieldByRegex(visibleFields, emailRe, emailJa);
  var dateOfBirth = findFieldByAC(visibleFields, "bday") || findFieldByRegex(visibleFields, dobRe, dobJa);
  var region = findFieldByAC(visibleFields, "address-level1") || findFieldByRegex(visibleFields, regionRe, regionJa);
  var country = findFieldByAC(visibleFields, "country-name") || findFieldByRegex(visibleFields, countryRe, countryJa);

  // Must have at least 2 fields
  var fieldCount = [
    fullName, givenName, familyName, familyNameKana, givenNameKana,
    address, addressLine2, city, postalCode, phone, email, dateOfBirth, region, country,
  ].filter(Boolean).length;
  if (fieldCount < 2) return;

  // ── Name ──
  // Prefer structured given/family; fall back to monolithic fullName ONLY for a
  // combined `name` field. NEVER split fullName into the split fields (forbidden).
  var hasStructuredName = Boolean(payload.givenName || payload.familyName);
  fillField(givenName, payload.givenName);
  fillField(familyName, payload.familyName);
  if (!hasStructuredName) {
    fillField(fullName, payload.fullName);
  }

  fillField(familyNameKana, payload.familyNameKana);
  fillField(givenNameKana, payload.givenNameKana);

  // ── Address ── (`address` slot already resolved structured-vs-monolithic upstream)
  fillField(address, payload.address);
  fillField(addressLine2, payload.addressLine2);
  fillField(city, payload.city);
  fillField(postalCode, payload.postalCode);
  fillField(country, payload.country);

  // Region (address-level1) prefers structured state, falls back to legacy nationality.
  fillField(region, payload.state || payload.nationality);

  fillField(phone, payload.phone);
  fillField(email, payload.email);
  fillField(dateOfBirth, payload.dateOfBirth);
}

// Guard against double-registration
var IDENTITY_AUTOFILL_GUARD = "__pssoIdentityAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.onMessage &&
  !window[IDENTITY_AUTOFILL_GUARD]
) {
  window[IDENTITY_AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener(function (message, sender) {
    // Only accept messages from our own extension — reject external senders.
    // Literal must equal EXT_MSG.AUTOFILL_IDENTITY_FILL in src/lib/constants.ts —
    // this plain-JS web-accessible resource cannot import the module.
    if (message && message.type === "AUTOFILL_IDENTITY_FILL" && sender.id === chrome.runtime.id) {
      performIdentityAutofill(message);
    }
  });
}
