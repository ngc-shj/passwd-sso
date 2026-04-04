// MAIN world WebAuthn interceptor — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Registered via chrome.scripting.registerContentScripts with world: "MAIN".
//
// Overrides navigator.credentials.get() and create() to offer
// passwd-sso passkeys as candidates before falling through to the
// platform authenticator.

(function () {
  "use strict";

  // Must match WEBAUTHN_BRIDGE_MSG / WEBAUTHN_BRIDGE_RESP in constants.ts
  var BRIDGE_MSG = "PASSWD_SSO_WEBAUTHN";
  var BRIDGE_RESP = "PASSWD_SSO_WEBAUTHN_RESP";
  var GUARD = "__pssoWebAuthnInterceptor";
  var TIMEOUT_MS = 120000; // 2 minute timeout for user interaction

  if (window[GUARD]) return;
  // Skip on pages without WebAuthn support (e.g. HTTP, non-secure contexts)
  if (!navigator.credentials || !navigator.credentials.get || !navigator.credentials.create) return;
  window[GUARD] = true;

  var origGet = navigator.credentials.get.bind(navigator.credentials);
  var origCreate = navigator.credentials.create.bind(navigator.credentials);

  var pendingRequests = {};

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== BRIDGE_RESP) return;
    var reqId = event.data.requestId;
    if (reqId && pendingRequests[reqId]) {
      pendingRequests[reqId](event.data);
      delete pendingRequests[reqId];
    }
  });

  function sendBridgeMessage(action, payload) {
    return new Promise(function (resolve) {
      var requestId = crypto.randomUUID();
      var timer = setTimeout(function () {
        delete pendingRequests[requestId];
        resolve(null); // Timeout — fall through to platform
      }, TIMEOUT_MS);

      pendingRequests[requestId] = function (data) {
        clearTimeout(timer);
        resolve(data);
      };

      window.postMessage(
        { type: BRIDGE_MSG, requestId: requestId, action: action, payload: payload },
        window.location.origin,
      );
    });
  }

  navigator.credentials.get = function (options) {
    if (!options || !options.publicKey) {
      return origGet(options);
    }

    var pk = options.publicKey;
    var rpId = pk.rpId || window.location.hostname;

    // Validate rpId is a registrable domain suffix of the page hostname
    if (pk.rpId && !isValidRpId(pk.rpId, window.location.hostname)) {
      return origGet(options);
    }

    return sendBridgeMessage("PASSKEY_GET_MATCHES", { rpId: rpId }).then(function (resp) {
      if (
        !resp ||
        !resp.response ||
        resp.response.vaultLocked ||
        !resp.response.entries ||
        resp.response.entries.length === 0
      ) {
        return origGet(options);
      }

      var entries = resp.response.entries;

      if (pk.allowCredentials && pk.allowCredentials.length > 0) {
        var allowIds = pk.allowCredentials.map(function (c) {
          var idBytes = c.id instanceof ArrayBuffer
            ? new Uint8Array(c.id)
            : new Uint8Array(c.id.buffer || c.id);
          return uint8ToBase64url(idBytes);
        });
        entries = entries.filter(function (e) {
          return allowIds.indexOf(e.credentialId) !== -1;
        });
        if (entries.length === 0) {
          return origGet(options);
        }
      }
      return sendBridgeMessage("PASSKEY_SELECT", {
        entries: entries,
        rpId: rpId,
      }).then(function (selectResp) {
        // User dismissed or chose platform authenticator
        if (!selectResp || !selectResp.response || selectResp.response.action === "platform") {
          return origGet(options);
        }
        if (selectResp.response.action === "cancel") {
          throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
        }

        var selected = selectResp.response.entry;
        if (!selected) {
          return origGet(options);
        }

        var challengeBytes = pk.challenge instanceof ArrayBuffer
          ? new Uint8Array(pk.challenge)
          : new Uint8Array(pk.challenge.buffer || pk.challenge);
        var challengeB64 = uint8ToBase64url(challengeBytes);

        var clientDataJSON = JSON.stringify({
          type: "webauthn.get",
          challenge: challengeB64,
          origin: window.location.origin,
          crossOrigin: false,
        });

        return sendBridgeMessage("PASSKEY_SIGN_ASSERTION", {
          entryId: selected.id,
          clientDataJSON: clientDataJSON,
          teamId: selected.teamId || undefined,
        }).then(function (signResp) {
          if (!signResp || !signResp.response || !signResp.response.ok) {
            return origGet(options);
          }

          var assertion = signResp.response.response;
          return buildPublicKeyCredential(
            assertion.credentialId,
            base64urlToUint8(assertion.authenticatorData),
            new TextEncoder().encode(clientDataJSON),
            base64urlToUint8(assertion.signature),
            assertion.userHandle ? base64urlToUint8(assertion.userHandle) : null,
          );
        });
      });
    }).catch(function (err) {
      if (err instanceof DOMException) throw err;
      // On any internal error, fall through to platform
      return origGet(options);
    });
  };

  navigator.credentials.create = function (options) {
    if (!options || !options.publicKey) {
      return origCreate(options);
    }

    var pk = options.publicKey;
    var rpId = (pk.rp && pk.rp.id) || window.location.hostname;
    var rpName = (pk.rp && pk.rp.name) || rpId;

    // Validate rpId is a registrable domain suffix of the page hostname
    if (pk.rp && pk.rp.id && !isValidRpId(pk.rp.id, window.location.hostname)) {
      return origCreate(options);
    }

    var userIdBytes = pk.user && pk.user.id
      ? (pk.user.id instanceof ArrayBuffer
          ? new Uint8Array(pk.user.id)
          : new Uint8Array(pk.user.id.buffer || pk.user.id))
      : new Uint8Array(0);
    var userId = uint8ToBase64url(userIdBytes);
    var userName = (pk.user && pk.user.name) || "";
    var userDisplayName = (pk.user && pk.user.displayName) || userName;

    var challengeBytes = pk.challenge instanceof ArrayBuffer
      ? new Uint8Array(pk.challenge)
      : new Uint8Array(pk.challenge.buffer || pk.challenge);
    var challengeB64 = uint8ToBase64url(challengeBytes);

    var excludeIds = (pk.excludeCredentials || []).map(function (c) {
      var idBytes = c.id instanceof ArrayBuffer
        ? new Uint8Array(c.id)
        : new Uint8Array(c.id.buffer || c.id);
      return uint8ToBase64url(idBytes);
    });

    return sendBridgeMessage("PASSKEY_CONFIRM_CREATE", {
      rpId: rpId,
      rpName: rpName,
      userName: userName,
      userDisplayName: userDisplayName,
      userId: userId,
    }).then(function (confirmResp) {
      if (!confirmResp || !confirmResp.response) {
        return origCreate(options);
      }
      if (confirmResp.response.action === "cancel") {
        throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
      }
      if (confirmResp.response.action !== "save") {
        return origCreate(options);
      }

      var clientDataJSON = JSON.stringify({
        type: "webauthn.create",
        challenge: challengeB64,
        origin: window.location.origin,
        crossOrigin: false,
      });

      return sendBridgeMessage("PASSKEY_CREATE_CREDENTIAL", {
        rpId: rpId,
        rpName: rpName,
        userId: userId,
        userName: userName,
        userDisplayName: userDisplayName,
        excludeCredentialIds: excludeIds,
        clientDataJSON: clientDataJSON,
        replaceEntryId: confirmResp.response.replaceEntryId || undefined,
      }).then(function (createResp) {
        if (!createResp || !createResp.response || !createResp.response.ok) {
          return origCreate(options);
        }

        var attestation = createResp.response.response;
        return buildPublicKeyCredentialAttestation(
          attestation.credentialId,
          base64urlToUint8(attestation.attestationObject),
          new TextEncoder().encode(clientDataJSON),
          attestation.transports || [],
          attestation.authData ? base64urlToUint8(attestation.authData) : null,
          attestation.publicKeyDer ? base64urlToUint8(attestation.publicKeyDer) : null,
        );
      });
    }).catch(function () {
      return origCreate(options);
    });
  };

  /**
   * Validate rpId is a registrable domain suffix of hostname.
   * Rejects empty strings and public suffix entries (e.g. "co.uk") via
   * label count heuristic — full PSL lookup not feasible in MAIN world.
   */
  function isValidRpId(rpId, hostname) {
    if (!rpId || rpId.length === 0) return false;
    if (rpId.split(".").filter(function(p) { return p.length > 0; }).length < 2) return false;
    if (rpId === hostname) return true;
    return hostname.endsWith("." + rpId);
  }

  function uint8ToBase64url(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64urlToUint8(str) {
    var base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    var padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Build a synthetic PublicKeyCredential for assertion (get).
   * Returns a plain object that behaves like PublicKeyCredential.
   */
  function buildPublicKeyCredential(credentialIdB64, authenticatorData, clientDataJSON, signature, userHandle) {
    var rawId = base64urlToUint8(credentialIdB64);

    var response = {
      authenticatorData: authenticatorData.buffer,
      clientDataJSON: clientDataJSON.buffer,
      signature: signature.buffer,
      userHandle: userHandle ? userHandle.buffer : null,
    };
    Object.setPrototypeOf(response, AuthenticatorAssertionResponse.prototype);

    var cred = {
      id: credentialIdB64,
      rawId: rawId.buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: response,
      getClientExtensionResults: function () { return {}; },
    };
    Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
    return cred;
  }

  /**
   * Build a synthetic PublicKeyCredential for attestation (create).
   */
  function buildPublicKeyCredentialAttestation(credentialIdB64, attestationObject, clientDataJSON, transports, authData, publicKeyDer) {
    var rawId = base64urlToUint8(credentialIdB64);

    var response = {
      attestationObject: attestationObject.buffer,
      clientDataJSON: clientDataJSON.buffer,
      getTransports: function () { return transports; },
      getPublicKey: function () { return publicKeyDer ? publicKeyDer.buffer : null; },
      getPublicKeyAlgorithm: function () { return -7; },
      getAuthenticatorData: function () { return authData ? authData.buffer : null; },
    };
    Object.setPrototypeOf(response, AuthenticatorAttestationResponse.prototype);

    var cred = {
      id: credentialIdB64,
      rawId: rawId.buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: response,
      getClientExtensionResults: function () { return {}; },
    };
    Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
    return cred;
  }
})();
