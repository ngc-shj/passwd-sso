/**
 * A JWK-shaped public key string with a non-ASCII character, and the lowercase
 * hex SHA-256 of its UTF-8 bytes (computed once with node:crypto). The
 * client's recipientKeyFingerprint and the database's
 * team_key_recipient_guard() must both reproduce FINGERPRINT_VECTOR_HEX.
 */
export const FINGERPRINT_VECTOR_JWK = '{"kty":"EC","crv":"P-256","x":"café-x","y":"y-coord"}';

export const FINGERPRINT_VECTOR_HEX = "a435c0f2086aceffb3e2654a31bb32408292f042dc6c33f8bbce20b94cd78d33";
