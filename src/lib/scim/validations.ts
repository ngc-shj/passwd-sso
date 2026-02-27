import { z } from "zod";

/**
 * SCIM User creation / PUT schema.
 *
 * `userName` is normalised to lowercase (RFC 7643 recommends case-insensitive
 * comparison; we enforce it at ingestion).
 */
export const scimUserSchema = z
  .object({
    schemas: z
      .array(z.string())
      .refine(
        (s) => s.includes("urn:ietf:params:scim:schemas:core:2.0:User"),
        "Missing User schema URN",
      ),
    userName: z.string().email().max(255),
    externalId: z.string().max(255).optional(),
    name: z
      .object({
        formatted: z.string().max(255).optional(),
        givenName: z.string().max(255).optional(),
        familyName: z.string().max(255).optional(),
      })
      .optional(),
    active: z.boolean().optional().default(true),
  })
  .transform((v) => ({
    ...v,
    userName: v.userName.toLowerCase(),
  }));

export type ScimUserInput = z.infer<typeof scimUserSchema>;

/**
 * SCIM PatchOp request schema (RFC 7644 §3.5.2).
 */
export const scimPatchOpSchema = z.object({
  schemas: z
    .array(z.string())
    .refine(
      (s) =>
        s.includes("urn:ietf:params:scim:api:messages:2.0:PatchOp"),
      "Missing PatchOp schema URN",
    ),
  Operations: z
    .array(
      z.object({
        op: z.enum(["add", "replace", "remove"]),
        path: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export type ScimPatchOpInput = z.infer<typeof scimPatchOpSchema>;

/**
 * SCIM Group creation schema (for POST /Groups).
 */
export const scimGroupSchema = z.object({
  schemas: z
    .array(z.string())
    .refine(
      (s) => s.includes("urn:ietf:params:scim:schemas:core:2.0:Group"),
      "Missing Group schema URN",
    ),
  displayName: z.string().min(1).max(255),
  externalId: z.string().max(255).optional(),
  members: z
    .array(
      z.object({
        value: z.string().min(1).max(255),
      }),
    )
    .max(1000)
    .optional()
    .default([]),
});

export type ScimGroupInput = z.infer<typeof scimGroupSchema>;
