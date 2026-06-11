import Foundation

// MARK: - Editable fields

/// The set of fields editable via the iOS form for both create and edit.
public struct EditableEntryFields: Sendable, Equatable {
  public let title: String
  public let username: String  // "" = none
  public let password: String
  public let url: String       // "" = none
  public let notes: String     // "" = none
  public let totpSecret: String  // "" = none

  public init(
    title: String,
    username: String,
    password: String,
    url: String = "",
    notes: String = "",
    totpSecret: String = ""
  ) {
    self.title = title
    self.username = username
    self.password = password
    self.url = url
    self.notes = notes
    self.totpSecret = totpSecret
  }
}

// MARK: - Builder errors

public enum PersonalEntryBlobBuilderError: Error, Equatable {
  case malformedJSON
}

// MARK: - Builder

/// Pure plaintext-JSON builder for personal vault entries.
/// No crypto, no I/O — operates on plaintext JSON `Data`.
///
/// CREATE path: builds a fresh minimal LOGIN blob whose shape the server and
/// decoder accept. EDIT path: preserves-unknown round-trip via JSONSerialization
/// so tags, generatorSettings, customFields, passwordHistory, etc. are never
/// dropped (the vanishing-entry fix).
public enum PersonalEntryBlobBuilder {

  /// CREATE: fresh minimal LOGIN blob + overview plaintext.
  public static func buildCreate(
    fields: EditableEntryFields
  ) throws -> (blob: Data, overview: Data) {
    var blobObj: [String: Any] = [:]
    var overviewObj: [String: Any] = [:]
    applyMutation(to: &blobObj, overview: &overviewObj, fields: fields)
    let blob = try serialize(blobObj)
    let overview = try serialize(overviewObj)
    return (blob: blob, overview: overview)
  }

  /// EDIT: preserve-unknown round-trip. Parse the existing decrypted plaintexts
  /// as JSON objects, mutate ONLY the edited keys, re-serialize. Unknown keys
  /// (tags, generatorSettings, passwordHistory, customFields, additionalUrlHosts,
  /// requireReprompt, travelSafe) pass through verbatim.
  ///
  /// Throws `PersonalEntryBlobBuilderError.malformedJSON` if either plaintext
  /// does not parse as a top-level JSON object.
  public static func applyEdits(
    blob existingBlob: Data,
    overview existingOverview: Data,
    fields: EditableEntryFields
  ) throws -> (blob: Data, overview: Data) {
    guard var blobObj = try? JSONSerialization.jsonObject(with: existingBlob) as? [String: Any],
          var overviewObj = try? JSONSerialization.jsonObject(with: existingOverview) as? [String: Any]
    else {
      throw PersonalEntryBlobBuilderError.malformedJSON
    }
    applyMutation(to: &blobObj, overview: &overviewObj, fields: fields)
    let blob = try serialize(blobObj)
    let overview = try serialize(overviewObj)
    return (blob: blob, overview: overview)
  }

  // MARK: - Private

  /// Shared mutator: applies EditableEntryFields onto a blob dict and an overview
  /// dict in place. Works for both create (empty dicts) and edit (existing dicts).
  private static func applyMutation(
    to blobObj: inout [String: Any],
    overview overviewObj: inout [String: Any],
    fields: EditableEntryFields
  ) {
    // Full blob mutations
    blobObj["title"] = fields.title
    blobObj["username"] = fields.username.isEmpty ? NSNull() : fields.username
    blobObj["password"] = fields.password
    blobObj["url"] = fields.url.isEmpty ? NSNull() : fields.url
    blobObj["notes"] = fields.notes.isEmpty ? NSNull() : fields.notes

    // TOTP: preserve existing object's metadata (algorithm/digits/period) when
    // only the secret changes; set a minimal object when adding from scratch;
    // remove the key entirely when the secret is cleared.
    if fields.totpSecret.isEmpty {
      blobObj.removeValue(forKey: "totp")
    } else if var existing = blobObj["totp"] as? [String: Any] {
      existing["secret"] = fields.totpSecret
      blobObj["totp"] = existing
    } else {
      blobObj["totp"] = ["secret": fields.totpSecret]
    }

    // Overview mutations
    overviewObj["title"] = fields.title
    overviewObj["username"] = fields.username.isEmpty ? NSNull() : fields.username
    // Derive urlHost from the edited url.
    let host = URL(string: fields.url)?.host
    overviewObj["urlHost"] = (host.flatMap { $0.isEmpty ? nil : $0 }) ?? NSNull()

    // TOTP presence marker: set/remove hasTOTP in sync with the secret.
    if fields.totpSecret.isEmpty {
      overviewObj.removeValue(forKey: "hasTOTP")
    } else {
      // Store as a proper NSNumber(bool) so JSONSerialization round-trips it
      // as JSON `true`, not as integer `1`.
      overviewObj["hasTOTP"] = true
    }
  }

  private static func serialize(_ obj: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: obj, options: [])
  }
}
