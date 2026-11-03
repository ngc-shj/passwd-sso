import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";
import {
  ATTACHMENT_MIGRATE_PAYLOAD_MAX,
  ATTACHMENT_UPLOAD_MULTIPART_MAX,
  REKEY_BODY_MAX,
  VAULT_ROTATE_BODY_MAX,
} from "@/lib/validations/common";
import { SEND_MAX_FILE_SIZE } from "@/lib/validations/send";

// Beyond proxyClientMaxBodySize the proxy hands the route a truncated body
// instead of rejecting, so a route cap above it turns a valid request into a
// parse failure. The limit must cover every route body cap.
describe("next.config experimental.proxyClientMaxBodySize", () => {
  const limit = nextConfig.experimental?.proxyClientMaxBodySize;

  it("is a byte count", () => {
    expect(typeof limit).toBe("number");
  });

  it.each([
    ["REKEY_BODY_MAX", REKEY_BODY_MAX],
    ["VAULT_ROTATE_BODY_MAX", VAULT_ROTATE_BODY_MAX],
    ["ATTACHMENT_MIGRATE_PAYLOAD_MAX", ATTACHMENT_MIGRATE_PAYLOAD_MAX],
    ["ATTACHMENT_UPLOAD_MULTIPART_MAX", ATTACHMENT_UPLOAD_MULTIPART_MAX],
    ["send file multipart envelope", SEND_MAX_FILE_SIZE * 2],
  ])("covers %s", (_name, cap) => {
    expect(limit).toBeGreaterThanOrEqual(cap);
  });
});
