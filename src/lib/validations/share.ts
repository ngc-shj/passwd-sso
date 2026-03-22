import { z } from "zod";
import { CUSTOM_FIELD_TYPE_VALUES, SHARE_PERMISSION_VALUES } from "@/lib/constants";
import {
  ENTRY_NAME_MAX,
  ENTRY_SHORT_MAX,
  ENTRY_SECRET_MAX,
  ENTRY_NOTES_MAX,
  ENTRY_URL_MAX,
  SECURE_NOTE_MAX,
  PUBLIC_KEY_MAX,
  CARD_NUMBER_MAX,
  SWIFT_BIC_MAX,
  NAME_MAX_LENGTH,
  MAX_VIEWS_MIN,
  MAX_VIEWS_MAX,
  EXPIRY_PERIODS,
  SHARE_ACCESS_PASSWORD_MAX,
  encryptedFieldSchema,
  hexHash,
} from "./common";
import { entryTypeSchema } from "./entry";

// ─── Share Link Schemas ───────────────────────────────────

const shareDataSchema = z.object({
  title: z.string().min(1).max(ENTRY_NAME_MAX),
  username: z.string().max(ENTRY_NAME_MAX).nullish(),
  password: z.string().nullish(),
  url: z.string().max(ENTRY_URL_MAX).nullish(),
  notes: z.string().max(ENTRY_NOTES_MAX).nullish(),
  customFields: z.array(z.object({
    label: z.string().max(NAME_MAX_LENGTH),
    value: z.string().max(ENTRY_NOTES_MAX),
    type: z.enum(CUSTOM_FIELD_TYPE_VALUES),
  })).nullish(),
  // SECURE_NOTE
  content: z.string().max(SECURE_NOTE_MAX).nullish(),
  // CREDIT_CARD
  cardholderName: z.string().max(ENTRY_NAME_MAX).nullish(),
  cardNumber: z.string().max(CARD_NUMBER_MAX).nullish(),
  brand: z.string().max(ENTRY_SHORT_MAX).nullish(),
  expiryMonth: z.string().max(2).nullish(),
  expiryYear: z.string().max(4).nullish(),
  cvv: z.string().max(10).nullish(),
  // PASSKEY
  relyingPartyId: z.string().max(ENTRY_NAME_MAX).nullish(),
  relyingPartyName: z.string().max(ENTRY_NAME_MAX).nullish(),
  credentialId: z.string().max(ENTRY_SECRET_MAX).nullish(),
  creationDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  deviceInfo: z.string().max(ENTRY_NAME_MAX).nullish(),
  // IDENTITY
  fullName: z.string().max(ENTRY_NAME_MAX).nullish(),
  address: z.string().max(ENTRY_SECRET_MAX).nullish(),
  phone: z.string().max(ENTRY_SHORT_MAX).nullish(),
  email: z.string().max(ENTRY_NAME_MAX).nullish(),
  dateOfBirth: z.string().max(ENTRY_SHORT_MAX).nullish(),
  nationality: z.string().max(NAME_MAX_LENGTH).nullish(),
  idNumber: z.string().max(NAME_MAX_LENGTH).nullish(),
  issueDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  expiryDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  // BANK_ACCOUNT
  bankName: z.string().max(ENTRY_NAME_MAX).nullish(),
  accountType: z.string().max(ENTRY_SHORT_MAX).nullish(),
  accountHolderName: z.string().max(ENTRY_NAME_MAX).nullish(),
  accountNumber: z.string().max(ENTRY_SHORT_MAX).nullish(),
  routingNumber: z.string().max(ENTRY_SHORT_MAX).nullish(),
  swiftBic: z.string().max(SWIFT_BIC_MAX).nullish(),
  iban: z.string().max(ENTRY_SHORT_MAX).nullish(),
  branchName: z.string().max(ENTRY_NAME_MAX).nullish(),
  // SOFTWARE_LICENSE
  softwareName: z.string().max(ENTRY_NAME_MAX).nullish(),
  licenseKey: z.string().max(ENTRY_SECRET_MAX).nullish(),
  version: z.string().max(ENTRY_SHORT_MAX).nullish(),
  licensee: z.string().max(ENTRY_NAME_MAX).nullish(),
  purchaseDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  expirationDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  // SSH_KEY
  privateKey: z.string().max(ENTRY_NOTES_MAX).nullish(),
  publicKey: z.string().max(PUBLIC_KEY_MAX).nullish(),
  keyType: z.string().max(ENTRY_SHORT_MAX).nullish(),
  keySize: z.number().int().nullish(),
  fingerprint: z.string().max(ENTRY_NAME_MAX).nullish(),
  passphrase: z.string().max(ENTRY_SECRET_MAX).nullish(),
  comment: z.string().max(ENTRY_SECRET_MAX).nullish(),
});

export const createShareLinkSchema = z.object({
  passwordEntryId: z.string().uuid().optional(),
  teamPasswordEntryId: z.string().uuid().optional(),
  data: shareDataSchema.optional(),
  encryptedShareData: encryptedFieldSchema.optional(),
  entryType: entryTypeSchema.optional(),
  expiresIn: z.enum(EXPIRY_PERIODS),
  maxViews: z.number().int().min(MAX_VIEWS_MIN).max(MAX_VIEWS_MAX).optional(),
  permissions: z.array(z.enum(SHARE_PERMISSION_VALUES)).optional(),
  requirePassword: z.boolean().optional(),
}).refine(
  (d) => (d.passwordEntryId ? !d.teamPasswordEntryId : !!d.teamPasswordEntryId),
  { message: "Exactly one of passwordEntryId or teamPasswordEntryId is required" }
).refine(
  (d) => (d.passwordEntryId ? !!d.data : true),
  { message: "data is required for personal entries" }
).refine(
  (d) => (d.teamPasswordEntryId ? !!d.encryptedShareData && !!d.entryType : true),
  { message: "encryptedShareData and entryType are required for team entries" }
).refine(
  (d) => (d.teamPasswordEntryId ? !d.data : true),
  { message: "data must not be present for team entries (use encryptedShareData)" }
);

// ─── Share Access Password Schemas ────────────────────────

export const verifyShareAccessSchema = z.object({
  token: hexHash,
  password: z.string().min(1).max(SHARE_ACCESS_PASSWORD_MAX),
});

// ─── Type Exports ──────────────────────────────────────────

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type VerifyShareAccessInput = z.infer<typeof verifyShareAccessSchema>;
