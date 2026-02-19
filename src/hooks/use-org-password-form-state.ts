import { useState } from "react";
import { formatCardNumber } from "@/lib/credit-card";
import type {
  GeneratorSettings,
} from "@/lib/generator-prefs";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgAttachmentMeta } from "@/components/org/org-attachment-section";

export function useOrgPasswordFormState(editData?: OrgPasswordFormEditData | null) {
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [showCredentialId, setShowCredentialId] = useState(false);

  const [title, setTitle] = useState(editData?.title ?? "");
  const [username, setUsername] = useState(editData?.username ?? "");
  const [password, setPassword] = useState(editData?.password ?? "");
  const [content, setContent] = useState(editData?.content ?? "");
  const [url, setUrl] = useState(editData?.url ?? "");
  const [notes, setNotes] = useState(editData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<OrgTagData[]>(editData?.tags ?? []);
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>({
    ...DEFAULT_GENERATOR_SETTINGS,
  });
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(editData?.customFields ?? []);
  const [totp, setTotp] = useState<EntryTotp | null>(editData?.totp ?? null);
  const [showTotpInput, setShowTotpInput] = useState(!!editData?.totp);

  const [cardholderName, setCardholderName] = useState(editData?.cardholderName ?? "");
  const [cardNumber, setCardNumber] = useState(
    formatCardNumber(editData?.cardNumber ?? "", editData?.brand ?? ""),
  );
  const [brand, setBrand] = useState(editData?.brand ?? "");
  const [brandSource, setBrandSource] = useState<"auto" | "manual">(
    editData?.brand ? "manual" : "auto",
  );
  const [expiryMonth, setExpiryMonth] = useState(editData?.expiryMonth ?? "");
  const [expiryYear, setExpiryYear] = useState(editData?.expiryYear ?? "");
  const [cvv, setCvv] = useState(editData?.cvv ?? "");

  const [fullName, setFullName] = useState(editData?.fullName ?? "");
  const [address, setAddress] = useState(editData?.address ?? "");
  const [phone, setPhone] = useState(editData?.phone ?? "");
  const [email, setEmail] = useState(editData?.email ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(editData?.dateOfBirth ?? "");
  const [nationality, setNationality] = useState(editData?.nationality ?? "");
  const [idNumber, setIdNumber] = useState(editData?.idNumber ?? "");
  const [issueDate, setIssueDate] = useState(editData?.issueDate ?? "");
  const [expiryDate, setExpiryDate] = useState(editData?.expiryDate ?? "");
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);

  const [relyingPartyId, setRelyingPartyId] = useState(editData?.relyingPartyId ?? "");
  const [relyingPartyName, setRelyingPartyName] = useState(editData?.relyingPartyName ?? "");
  const [credentialId, setCredentialId] = useState(editData?.credentialId ?? "");
  const [creationDate, setCreationDate] = useState(editData?.creationDate ?? "");
  const [deviceInfo, setDeviceInfo] = useState(editData?.deviceInfo ?? "");
  const [orgFolderId, setOrgFolderId] = useState<string | null>(editData?.orgFolderId ?? null);

  const values = {
    saving,
    showPassword,
    showGenerator,
    showCardNumber,
    showCvv,
    showIdNumber,
    showCredentialId,
    title,
    username,
    password,
    content,
    url,
    notes,
    selectedTags,
    generatorSettings,
    customFields,
    totp,
    showTotpInput,
    cardholderName,
    cardNumber,
    brand,
    brandSource,
    expiryMonth,
    expiryYear,
    cvv,
    fullName,
    address,
    phone,
    email,
    dateOfBirth,
    nationality,
    idNumber,
    issueDate,
    expiryDate,
    dobError,
    expiryError,
    relyingPartyId,
    relyingPartyName,
    credentialId,
    creationDate,
    deviceInfo,
    orgFolderId,
  };

  const setters = {
    setSaving,
    setShowPassword,
    setShowGenerator,
    setShowCardNumber,
    setShowCvv,
    setShowIdNumber,
    setShowCredentialId,
    setTitle,
    setUsername,
    setPassword,
    setContent,
    setUrl,
    setNotes,
    setSelectedTags,
    setGeneratorSettings,
    setCustomFields,
    setTotp,
    setShowTotpInput,
    setCardholderName,
    setCardNumber,
    setBrand,
    setBrandSource,
    setExpiryMonth,
    setExpiryYear,
    setCvv,
    setFullName,
    setAddress,
    setPhone,
    setEmail,
    setDateOfBirth,
    setNationality,
    setIdNumber,
    setIssueDate,
    setExpiryDate,
    setDobError,
    setExpiryError,
    setRelyingPartyId,
    setRelyingPartyName,
    setCredentialId,
    setCreationDate,
    setDeviceInfo,
    setOrgFolderId,
  };

  return { values, setters };
}

export type OrgPasswordFormState = ReturnType<typeof useOrgPasswordFormState>;
export type OrgPasswordFormValues = OrgPasswordFormState["values"];
export type OrgPasswordFormSettersState = OrgPasswordFormState["setters"];
export type OrgPasswordFormLifecycleSetters = OrgPasswordFormSettersState & {
  setAttachments: (value: OrgAttachmentMeta[]) => void;
};

export interface OrgEntryFieldValues {
  title: string;
  notes: string;
  selectedTags: OrgTagData[];
  orgFolderId: string | null;
  username: string;
  password: string;
  url: string;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  content: string;
  cardholderName: string;
  cardNumber: string;
  brand: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  fullName: string;
  address: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  nationality: string;
  idNumber: string;
  issueDate: string;
  expiryDate: string;
  relyingPartyId: string;
  relyingPartyName: string;
  credentialId: string;
  creationDate: string;
  deviceInfo: string;
}

export function selectOrgEntryFieldValues(values: OrgPasswordFormValues): OrgEntryFieldValues {
  return {
    title: values.title,
    notes: values.notes,
    selectedTags: values.selectedTags,
    orgFolderId: values.orgFolderId,
    username: values.username,
    password: values.password,
    url: values.url,
    customFields: values.customFields,
    totp: values.totp,
    content: values.content,
    cardholderName: values.cardholderName,
    cardNumber: values.cardNumber,
    brand: values.brand,
    expiryMonth: values.expiryMonth,
    expiryYear: values.expiryYear,
    cvv: values.cvv,
    fullName: values.fullName,
    address: values.address,
    phone: values.phone,
    email: values.email,
    dateOfBirth: values.dateOfBirth,
    nationality: values.nationality,
    idNumber: values.idNumber,
    issueDate: values.issueDate,
    expiryDate: values.expiryDate,
    relyingPartyId: values.relyingPartyId,
    relyingPartyName: values.relyingPartyName,
    credentialId: values.credentialId,
    creationDate: values.creationDate,
    deviceInfo: values.deviceInfo,
  };
}
