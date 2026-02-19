import type { SubmitOrgPasswordFormArgs } from "@/components/org/org-password-form-actions";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgPasswordFormValues } from "@/hooks/use-org-password-form-state";
type TFn = (key: string) => string;

interface SubmitFormState {
  values: Pick<
    OrgPasswordFormValues,
    | "title"
    | "notes"
    | "selectedTags"
    | "orgFolderId"
    | "username"
    | "password"
    | "url"
    | "customFields"
    | "totp"
    | "content"
    | "cardholderName"
    | "cardNumber"
    | "brand"
    | "expiryMonth"
    | "expiryYear"
    | "cvv"
    | "fullName"
    | "address"
    | "phone"
    | "email"
    | "dateOfBirth"
    | "nationality"
    | "idNumber"
    | "issueDate"
    | "expiryDate"
    | "relyingPartyId"
    | "relyingPartyName"
    | "credentialId"
    | "creationDate"
    | "deviceInfo"
  >;
  setters: {
    setDobError: (value: string | null) => void;
    setExpiryError: (value: string | null) => void;
    setSaving: (value: boolean) => void;
  };
}

interface BuildOrgPasswordSubmitArgsInput {
  orgId: string;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  cardNumberValid: boolean;
  isIdentity: boolean;
  t: TFn;
  ti: TFn;
  onSaved: () => void;
  handleOpenChange: (open: boolean) => void;
  formState: SubmitFormState;
}

export function buildOrgPasswordSubmitArgs({
  orgId,
  isEdit,
  editData,
  effectiveEntryType,
  cardNumberValid,
  isIdentity,
  t,
  ti,
  onSaved,
  handleOpenChange,
  formState,
}: BuildOrgPasswordSubmitArgsInput): SubmitOrgPasswordFormArgs {
  const { values, setters } = formState;

  return {
    orgId,
    isEdit,
    editData,
    effectiveEntryType,
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
    cardNumberValid,
    isIdentity,
    setDobError: setters.setDobError,
    setExpiryError: setters.setExpiryError,
    identityErrorCopy: {
      dobFuture: ti("dobFuture"),
      expiryBeforeIssue: ti("expiryBeforeIssue"),
    },
    t,
    setSaving: setters.setSaving,
    handleOpenChange,
    onSaved,
  };
}
