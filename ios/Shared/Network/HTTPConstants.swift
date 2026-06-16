import Foundation

public enum HTTPHeader {
  public static let contentType = "Content-Type"
  public static let authorization = "Authorization"
  public static let dpop = "DPoP"
  public static let dpopNonce = "DPoP-Nonce"
}

public enum HTTPMethod {
  public static let get = "GET"
  public static let post = "POST"
  public static let put = "PUT"
}

public enum HTTPContentType {
  public static let json = "application/json"
}

public enum HTTPAuthScheme {
  public static let bearerPrefix = "Bearer "
  public static let dpopPrefix = "DPoP "
}
