import Foundation
import CryptoKit

/// Hex encode raw bytes to lowercase hex string.
public func hexEncode(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

/// Decode a lowercase or uppercase hex string to Data.
public func hexDecode(_ s: String) throws -> Data {
  guard s.count % 2 == 0 else {
    throw CryptoUtilsError.invalidHexString
  }
  var result = Data(capacity: s.count / 2)
  var index = s.startIndex
  while index < s.endIndex {
    let nextIndex = s.index(index, offsetBy: 2)
    guard let byte = UInt8(s[index..<nextIndex], radix: 16) else {
      throw CryptoUtilsError.invalidHexString
    }
    result.append(byte)
    index = nextIndex
  }
  return result
}

/// Base64url encode (no padding, URL-safe alphabet).
public func base64URLEncode(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

/// Base64url decode (accepts both padded and unpadded, URL-safe alphabet).
public func base64URLDecode(_ s: String) throws -> Data {
  var padded = s
    .replacingOccurrences(of: "-", with: "+")
    .replacingOccurrences(of: "_", with: "/")
  let remainder = padded.count % 4
  if remainder != 0 {
    padded += String(repeating: "=", count: 4 - remainder)
  }
  guard let data = Data(base64Encoded: padded) else {
    throw CryptoUtilsError.invalidBase64URLString
  }
  return data
}

/// Constant-time comparison of two Data values using XOR sum.
/// Returns true only if lengths match and all bytes are equal.
public func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
  guard a.count == b.count else { return false }
  var diff: UInt8 = 0
  for (x, y) in zip(a, b) {
    diff |= x ^ y
  }
  return diff == 0
}

public enum CryptoUtilsError: Error, Equatable {
  case invalidHexString
  case invalidBase64URLString
}
