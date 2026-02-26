import type { TeamPasswordFormEditData } from "@/components/team/team-password-form-types";
import type { TeamAttachmentMeta } from "@/components/team/team-attachment-section";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import { useTeamPasswordFormUiState } from "@/hooks/use-team-password-form-ui-state";
import { useTeamPasswordFormValueState } from "@/hooks/use-team-password-form-value-state";
import { buildTeamPasswordFormInitialValues } from "@/hooks/team-password-form-initial-values";

export function useTeamPasswordFormState(editData?: TeamPasswordFormEditData | null) {
  const initial = buildTeamPasswordFormInitialValues(editData);
  const uiState = useTeamPasswordFormUiState();
  const valueState = useTeamPasswordFormValueState(initial);

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

export type TeamPasswordFormState = ReturnType<typeof useTeamPasswordFormState>;
export type TeamPasswordFormValues = TeamPasswordFormState["values"];
export type TeamPasswordFormSettersState = TeamPasswordFormState["setters"];
export type TeamPasswordFormLifecycleSetters = TeamPasswordFormSettersState & {
  setAttachments: (value: TeamAttachmentMeta[]) => void;
};

export interface TeamEntryFieldValues {
  title: string;
  notes: string;
  selectedTags: TeamTagData[];
  teamFolderId: string | null;
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

export function selectTeamEntryFieldValues(values: TeamPasswordFormValues): TeamEntryFieldValues {
  return {
    title: values.title,
    notes: values.notes,
    selectedTags: values.selectedTags,
    teamFolderId: values.teamFolderId,
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
