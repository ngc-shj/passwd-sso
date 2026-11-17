import { describe, it, expect } from "vitest";
import {
  encryptServerData,
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { deliveryTargetEndpoint } from "./audit-delivery-target-endpoint";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

function rowFor(config: object, { id = TARGET_ID, tenantId = TENANT_ID } = {}) {
  const version = getCurrentMasterKeyVersion();
  const aad = Buffer.concat([
    Buffer.from(id.replace(/-/g, ""), "hex"),
    Buffer.from(tenantId.replace(/-/g, ""), "hex"),
  ]);
  const enc = encryptServerData(JSON.stringify(config), getMasterKeyByVersion(version), aad);
  return {
    id: TARGET_ID,
    masterKeyVersion: version,
    configEncrypted: enc.ciphertext,
    configIv: enc.iv,
    configAuthTag: enc.authTag,
  };
}

describe("deliveryTargetEndpoint", () => {
  it("returns the masked url without query or secret", () => {
    const row = rowFor({ url: "https://siem.example.com/hec?token=abc#frag", token: "SECRET-TOKEN" });
    const endpoint = deliveryTargetEndpoint(row, TENANT_ID);
    expect(endpoint).toContain("siem.example.com");
    expect(endpoint).not.toContain("abc");
    expect(endpoint).not.toContain("SECRET-TOKEN");
  });

  it("reads the endpoint field of an S3 target", () => {
    const row = rowFor({ endpoint: "https://s3.example.com/bucket", region: "r", secretAccessKey: "SECRET-KEY" });
    expect(deliveryTargetEndpoint(row, TENANT_ID)).toContain("s3.example.com");
  });

  it("returns null when the AAD does not match (decrypt failure)", () => {
    const row = rowFor({ url: "https://siem.example.com/hec" });
    expect(deliveryTargetEndpoint(row, "33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("returns null when the master key version is unknown", () => {
    const row = { ...rowFor({ url: "https://siem.example.com/hec" }), masterKeyVersion: 99 };
    expect(deliveryTargetEndpoint(row, TENANT_ID)).toBeNull();
  });

  it("returns null when the config names neither url nor endpoint", () => {
    expect(deliveryTargetEndpoint(rowFor({ region: "r" }), TENANT_ID)).toBeNull();
  });
});
