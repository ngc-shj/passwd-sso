import type { TagData } from "@/components/tags/tag-input";
import type { GeneratorSettings } from "@/lib/generator/generator-prefs";
import type {
  EntryCustomField,
  EntryPasswordHistory,
  EntryTotp,
} from "@/lib/vault/entry-form-types";
import type { EntryTypeValue } from "@/lib/constants";

export interface PersonalPasswordEditData {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string;
  password: string;
  content: string;
  url: string;
  notes: string;
  tags: TagData[];
  generatorSettings?: GeneratorSettings;
  passwordHistory?: EntryPasswordHistory[];
  customFields?: EntryCustomField[];
  totp?: EntryTotp;
  cardholderName?: string | null;
  cardNumber?: string | null;
  brand?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
  cvv?: string | null;
  fullName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  // Passkey provider fields (opaque, preserved on round-trip)
  passkeyPrivateKeyJwk?: string | null;
  passkeyPublicKeyCose?: string | null;
  passkeyUserHandle?: string | null;
  passkeyUserDisplayName?: string | null;
  passkeySignCount?: number | null;
  passkeyAlgorithm?: number | null;
  passkeyTransports?: string[] | null;
  bankName?: string | null;
  accountType?: string | null;
  accountHolderName?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  branchName?: string | null;
  softwareName?: string | null;
  licenseKey?: string | null;
  version?: string | null;
  licensee?: string | null;
  purchaseDate?: string | null;
  expirationDate?: string | null;
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
  keySize?: number | null;
  fingerprint?: string | null;
  passphrase?: string | null;
  sshComment?: string | null;
  requireReprompt?: boolean;
  travelSafe?: boolean;
  expiresAt?: string | null;
  folderId?: string | null;
}
