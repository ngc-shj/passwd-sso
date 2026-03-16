/**
 * OpenAPI 3.1 specification for the passwd-sso public REST API.
 *
 * All data endpoints return E2E encrypted blobs — the server never sees plaintext.
 */

import { HEX_IV_LENGTH, HEX_AUTH_TAG_LENGTH } from "@/lib/validations/common";

export function buildOpenApiSpec(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "passwd-sso Public API",
      version: "1.0.0",
      description:
        "REST API for programmatic access to passwd-sso vaults. " +
        "All password data is end-to-end encrypted; the API returns encrypted blobs that must be decrypted client-side.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/passwords": {
        get: {
          operationId: "listPasswords",
          summary: "List password entries",
          tags: ["Passwords"],
          parameters: [
            { name: "tag", in: "query", schema: { type: "string" }, description: "Filter by tag ID" },
            { name: "type", in: "query", schema: { type: "string" }, description: "Filter by entry type" },
            { name: "include", in: "query", schema: { type: "string", enum: ["blob"] }, description: "Include encrypted blob" },
            { name: "favorites", in: "query", schema: { type: "string", enum: ["true"] }, description: "Favorites only" },
            { name: "trash", in: "query", schema: { type: "string", enum: ["true"] }, description: "Trashed only" },
            { name: "archived", in: "query", schema: { type: "string", enum: ["true"] }, description: "Archived only" },
            { name: "folder", in: "query", schema: { type: "string" }, description: "Filter by folder ID" },
          ],
          responses: {
            "200": {
              description: "Array of encrypted password entries",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/PasswordEntry" } } } },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
        post: {
          operationId: "createPassword",
          summary: "Create a password entry",
          tags: ["Passwords"],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreatePasswordInput" } } },
          },
          responses: {
            "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/PasswordEntry" } } } },
            "400": { $ref: "#/components/responses/ValidationError" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/v1/passwords/{id}": {
        get: {
          operationId: "getPassword",
          summary: "Get a password entry with full blob",
          tags: ["Passwords"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Password entry with encrypted blob", content: { "application/json": { schema: { $ref: "#/components/schemas/PasswordEntryDetail" } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
        put: {
          operationId: "updatePassword",
          summary: "Update a password entry",
          tags: ["Passwords"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/UpdatePasswordInput" } } },
          },
          responses: {
            "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/PasswordEntry" } } } },
            "400": { $ref: "#/components/responses/ValidationError" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
        delete: {
          operationId: "deletePassword",
          summary: "Soft-delete (trash) or permanently delete",
          tags: ["Passwords"],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "permanent", in: "query", schema: { type: "string", enum: ["true"] }, description: "Permanently delete" },
          ],
          responses: {
            "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" } } } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/v1/tags": {
        get: {
          operationId: "listTags",
          summary: "List tags",
          tags: ["Tags"],
          responses: {
            "200": {
              description: "Array of tags",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Tag" } } } },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/v1/vault/status": {
        get: {
          operationId: "getVaultStatus",
          summary: "Check vault initialization status",
          tags: ["Vault"],
          responses: {
            "200": {
              description: "Vault status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      initialized: { type: "boolean" },
                      keyVersion: { type: ["integer", "null"] },
                    },
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API key (prefixed with `api_`)",
        },
      },
      schemas: {
        EncryptedField: {
          type: "object",
          required: ["ciphertext", "iv", "authTag"],
          properties: {
            ciphertext: { type: "string", description: "Hex-encoded AES-256-GCM ciphertext" },
            iv: { type: "string", description: "Hex-encoded 12-byte IV", minLength: HEX_IV_LENGTH, maxLength: HEX_IV_LENGTH },
            authTag: { type: "string", description: "Hex-encoded 16-byte auth tag", minLength: HEX_AUTH_TAG_LENGTH, maxLength: HEX_AUTH_TAG_LENGTH },
          },
        },
        PasswordEntry: {
          type: "object",
          properties: {
            id: { type: "string" },
            encryptedOverview: { $ref: "#/components/schemas/EncryptedField" },
            keyVersion: { type: "integer" },
            aadVersion: { type: "integer" },
            entryType: { type: "string" },
            isFavorite: { type: "boolean" },
            isArchived: { type: "boolean" },
            requireReprompt: { type: "boolean" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            folderId: { type: ["string", "null"] },
            tagIds: { type: "array", items: { type: "string" } },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            deletedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        PasswordEntryDetail: {
          allOf: [
            { $ref: "#/components/schemas/PasswordEntry" },
            {
              type: "object",
              properties: {
                encryptedBlob: { $ref: "#/components/schemas/EncryptedField" },
              },
            },
          ],
        },
        CreatePasswordInput: {
          type: "object",
          required: ["encryptedBlob", "encryptedOverview", "keyVersion"],
          properties: {
            id: { type: "string", format: "uuid", description: "Client-generated UUID" },
            encryptedBlob: { $ref: "#/components/schemas/EncryptedField" },
            encryptedOverview: { $ref: "#/components/schemas/EncryptedField" },
            keyVersion: { type: "integer", minimum: 1 },
            aadVersion: { type: "integer", minimum: 0, maximum: 1 },
            tagIds: { type: "array", items: { type: "string" } },
            folderId: { type: ["string", "null"] },
            isFavorite: { type: "boolean" },
            entryType: { type: "string" },
            requireReprompt: { type: "boolean" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        UpdatePasswordInput: {
          type: "object",
          properties: {
            encryptedBlob: { $ref: "#/components/schemas/EncryptedField" },
            encryptedOverview: { $ref: "#/components/schemas/EncryptedField" },
            keyVersion: { type: "integer" },
            aadVersion: { type: "integer" },
            tagIds: { type: "array", items: { type: "string" } },
            folderId: { type: ["string", "null"] },
            isFavorite: { type: "boolean" },
            isArchived: { type: "boolean" },
            entryType: { type: "string" },
            requireReprompt: { type: "boolean" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        Tag: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            color: { type: ["string", "null"] },
            parentId: { type: ["string", "null"] },
            passwordCount: { type: "integer" },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            details: {},
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Missing or invalid API key",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        Forbidden: {
          description: "Insufficient API key scope",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        NotFound: {
          description: "Resource not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        ValidationError: {
          description: "Validation error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        RateLimited: {
          description: "Rate limit exceeded",
          headers: {
            "Retry-After": { schema: { type: "integer" }, description: "Seconds until rate limit resets" },
          },
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
      },
    },
  };
}
