import { describe, it, expect } from "vitest";
import { buildOpenApiSpec } from "@/lib/openapi-spec";
import { HEX_IV_LENGTH, HEX_AUTH_TAG_LENGTH } from "@/lib/validations/common";

describe("buildOpenApiSpec", () => {
  const BASE_URL = "https://api.example.com";
  let spec: ReturnType<typeof buildOpenApiSpec>;

  beforeEach(() => {
    spec = buildOpenApiSpec(BASE_URL);
  });

  describe("top-level structure", () => {
    it("returns openapi version 3.1.0", () => {
      expect(spec.openapi).toBe("3.1.0");
    });

    it("sets the correct baseUrl in servers", () => {
      expect(spec.servers).toHaveLength(1);
      expect(spec.servers[0].url).toBe(BASE_URL);
    });

    it("applies global bearer security scheme", () => {
      expect(spec.security).toEqual([{ bearerAuth: [] }]);
    });

    it("includes info block with title and version", () => {
      expect(spec.info.title).toBe("passwd-sso Public API");
      expect(spec.info.version).toBe("1.0.0");
      expect(spec.info.description).toBeTruthy();
    });
  });

  describe("paths", () => {
    it("defines GET /api/v1/passwords (listPasswords)", () => {
      const op = spec.paths["/api/v1/passwords"].get;
      expect(op.operationId).toBe("listPasswords");
      expect(op.tags).toContain("Passwords");
      expect(op.responses["200"]).toBeDefined();
      expect(op.responses["401"]).toBeDefined();
    });

    it("GET /api/v1/passwords has tag, type, include, favorites, trash, archived, folder parameters", () => {
      const params = spec.paths["/api/v1/passwords"].get.parameters;
      const names = params.map((p: { name: string }) => p.name);
      expect(names).toEqual(expect.arrayContaining(["tag", "type", "include", "favorites", "trash", "archived", "folder"]));
    });

    it("defines POST /api/v1/passwords (createPassword)", () => {
      const op = spec.paths["/api/v1/passwords"].post;
      expect(op.operationId).toBe("createPassword");
      expect(op.requestBody.required).toBe(true);
      expect(op.responses["201"]).toBeDefined();
      expect(op.responses["400"]).toBeDefined();
    });

    it("defines GET /api/v1/passwords/{id} (getPassword)", () => {
      const op = spec.paths["/api/v1/passwords/{id}"].get;
      expect(op.operationId).toBe("getPassword");
      expect(op.parameters[0]).toMatchObject({ name: "id", in: "path", required: true });
      expect(op.responses["404"]).toBeDefined();
    });

    it("defines PUT /api/v1/passwords/{id} (updatePassword)", () => {
      const op = spec.paths["/api/v1/passwords/{id}"].put;
      expect(op.operationId).toBe("updatePassword");
      expect(op.requestBody.required).toBe(true);
    });

    it("defines DELETE /api/v1/passwords/{id} (deletePassword)", () => {
      const op = spec.paths["/api/v1/passwords/{id}"].delete;
      expect(op.operationId).toBe("deletePassword");
      const paramNames = op.parameters.map((p: { name: string }) => p.name);
      expect(paramNames).toContain("permanent");
    });

    it("defines GET /api/v1/tags (listTags)", () => {
      const op = spec.paths["/api/v1/tags"].get;
      expect(op.operationId).toBe("listTags");
      expect(op.tags).toContain("Tags");
    });

    it("defines GET /api/v1/vault/status (getVaultStatus)", () => {
      const op = spec.paths["/api/v1/vault/status"].get;
      expect(op.operationId).toBe("getVaultStatus");
      expect(op.tags).toContain("Vault");
      const schema = op.responses["200"].content["application/json"].schema;
      expect(schema.properties.initialized).toMatchObject({ type: "boolean" });
    });
  });

  describe("components.securitySchemes", () => {
    it("defines bearerAuth scheme of type http/bearer", () => {
      const bearerAuth = spec.components.securitySchemes.bearerAuth;
      expect(bearerAuth.type).toBe("http");
      expect(bearerAuth.scheme).toBe("bearer");
    });
  });

  describe("components.schemas", () => {
    it("EncryptedField has required fields ciphertext, iv, authTag", () => {
      const schema = spec.components.schemas.EncryptedField;
      expect(schema.required).toEqual(expect.arrayContaining(["ciphertext", "iv", "authTag"]));
    });

    it("EncryptedField iv has correct minLength/maxLength matching HEX_IV_LENGTH", () => {
      const ivProp = spec.components.schemas.EncryptedField.properties.iv;
      expect(ivProp.minLength).toBe(HEX_IV_LENGTH);
      expect(ivProp.maxLength).toBe(HEX_IV_LENGTH);
    });

    it("EncryptedField authTag has correct minLength/maxLength matching HEX_AUTH_TAG_LENGTH", () => {
      const authTagProp = spec.components.schemas.EncryptedField.properties.authTag;
      expect(authTagProp.minLength).toBe(HEX_AUTH_TAG_LENGTH);
      expect(authTagProp.maxLength).toBe(HEX_AUTH_TAG_LENGTH);
    });

    it("PasswordEntry schema has expected properties", () => {
      const schema = spec.components.schemas.PasswordEntry;
      const propNames = Object.keys(schema.properties);
      expect(propNames).toEqual(
        expect.arrayContaining(["id", "encryptedOverview", "keyVersion", "isFavorite", "isArchived"])
      );
    });

    it("PasswordEntryDetail is allOf extending PasswordEntry", () => {
      const schema = spec.components.schemas.PasswordEntryDetail;
      expect(schema.allOf).toBeDefined();
      const refs = schema.allOf.map((s: { $ref?: string }) => s.$ref).filter(Boolean);
      expect(refs).toContain("#/components/schemas/PasswordEntry");
    });

    it("PasswordEntryDetail includes encryptedBlob", () => {
      const schema = spec.components.schemas.PasswordEntryDetail;
      const extraProps = schema.allOf.find(
        (s: { type?: string }) => s.type === "object"
      );
      expect(extraProps?.properties?.encryptedBlob).toBeDefined();
    });

    it("CreatePasswordInput has required encryptedBlob, encryptedOverview, keyVersion", () => {
      const schema = spec.components.schemas.CreatePasswordInput;
      expect(schema.required).toEqual(
        expect.arrayContaining(["encryptedBlob", "encryptedOverview", "keyVersion"])
      );
    });

    it("Tag schema has id, name, color, parentId, passwordCount properties", () => {
      const schema = spec.components.schemas.Tag;
      const propNames = Object.keys(schema.properties);
      expect(propNames).toEqual(
        expect.arrayContaining(["id", "name", "color", "parentId", "passwordCount"])
      );
    });

    it("ErrorResponse requires error field", () => {
      const schema = spec.components.schemas.ErrorResponse;
      expect(schema.required).toContain("error");
    });
  });

  describe("components.responses", () => {
    it("defines Unauthorized response", () => {
      expect(spec.components.responses.Unauthorized).toBeDefined();
      expect(spec.components.responses.Unauthorized.description).toContain("API key");
    });

    it("defines Forbidden response", () => {
      expect(spec.components.responses.Forbidden).toBeDefined();
    });

    it("defines NotFound response", () => {
      expect(spec.components.responses.NotFound).toBeDefined();
    });

    it("defines ValidationError response", () => {
      expect(spec.components.responses.ValidationError).toBeDefined();
    });

    it("defines RateLimited response with Retry-After header", () => {
      const rl = spec.components.responses.RateLimited;
      expect(rl).toBeDefined();
      expect(rl.headers["Retry-After"]).toBeDefined();
    });
  });

  describe("different base URLs", () => {
    it("produces correct servers entry for localhost", () => {
      const localSpec = buildOpenApiSpec("http://localhost:3000");
      expect(localSpec.servers[0].url).toBe("http://localhost:3000");
    });

    it("produces correct servers entry for production URL", () => {
      const prodSpec = buildOpenApiSpec("https://vault.company.com");
      expect(prodSpec.servers[0].url).toBe("https://vault.company.com");
    });
  });
});
