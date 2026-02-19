import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgAttachmentMeta } from "@/components/org/org-attachment-section";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";
import { useOrgPasswordFormUiState } from "@/hooks/use-org-password-form-ui-state";
import { useOrgPasswordFormValueState } from "@/hooks/use-org-password-form-value-state";
import { buildOrgPasswordFormInitialValues } from "@/hooks/org-password-form-initial-values";

export function useOrgPasswordFormState(editData?: OrgPasswordFormEditData | null) {
  const initial = buildOrgPasswordFormInitialValues(editData);
  const uiState = useOrgPasswordFormUiState();
  const valueState = useOrgPasswordFormValueState(initial);

  const values = {
    ...uiState.values,
    ...valueState.values,
  };

  const setters = {
    ...uiState.setters,
    ...valueState.setters,
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
