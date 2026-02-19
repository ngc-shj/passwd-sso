import { formatCardNumber } from "@/lib/credit-card";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgPasswordFormLifecycleSetters } from "@/hooks/use-org-password-form-state";

export type OrgPasswordFormSetters = OrgPasswordFormLifecycleSetters;

export function applyOrgEditDataToForm(
  data: OrgPasswordFormEditData,
  setters: OrgPasswordFormSetters,
): void {
  setters.setTitle(data.title);
  setters.setUsername(data.username ?? "");
  setters.setPassword(data.password ?? "");
  setters.setContent(data.content ?? "");
  setters.setUrl(data.url ?? "");
  setters.setNotes(data.notes ?? "");
  setters.setSelectedTags(data.tags ?? []);
  setters.setCustomFields(data.customFields ?? []);
  setters.setTotp(data.totp ?? null);
  setters.setShowTotpInput(!!data.totp);
  setters.setCardholderName(data.cardholderName ?? "");
  setters.setCardNumber(formatCardNumber(data.cardNumber ?? "", data.brand ?? ""));
  setters.setBrand(data.brand ?? "");
  setters.setBrandSource(data.brand ? "manual" : "auto");
  setters.setExpiryMonth(data.expiryMonth ?? "");
  setters.setExpiryYear(data.expiryYear ?? "");
  setters.setCvv(data.cvv ?? "");
  setters.setFullName(data.fullName ?? "");
  setters.setAddress(data.address ?? "");
  setters.setPhone(data.phone ?? "");
  setters.setEmail(data.email ?? "");
  setters.setDateOfBirth(data.dateOfBirth ?? "");
  setters.setNationality(data.nationality ?? "");
  setters.setIdNumber(data.idNumber ?? "");
  setters.setIssueDate(data.issueDate ?? "");
  setters.setExpiryDate(data.expiryDate ?? "");
  setters.setRelyingPartyId(data.relyingPartyId ?? "");
  setters.setRelyingPartyName(data.relyingPartyName ?? "");
  setters.setCredentialId(data.credentialId ?? "");
  setters.setCreationDate(data.creationDate ?? "");
  setters.setDeviceInfo(data.deviceInfo ?? "");
  setters.setOrgFolderId(data.orgFolderId ?? null);
}

export function resetOrgFormForClose(setters: OrgPasswordFormSetters): void {
  setters.setTitle("");
  setters.setUsername("");
  setters.setPassword("");
  setters.setContent("");
  setters.setUrl("");
  setters.setNotes("");
  setters.setSelectedTags([]);
  setters.setCustomFields([]);
  setters.setTotp(null);
  setters.setShowTotpInput(false);
  setters.setShowPassword(false);
  setters.setShowGenerator(false);
  setters.setCardholderName("");
  setters.setCardNumber("");
  setters.setBrand("");
  setters.setBrandSource("auto");
  setters.setExpiryMonth("");
  setters.setExpiryYear("");
  setters.setCvv("");
  setters.setShowCardNumber(false);
  setters.setShowCvv(false);
  setters.setFullName("");
  setters.setAddress("");
  setters.setPhone("");
  setters.setEmail("");
  setters.setDateOfBirth("");
  setters.setNationality("");
  setters.setIdNumber("");
  setters.setIssueDate("");
  setters.setExpiryDate("");
  setters.setShowIdNumber(false);
  setters.setRelyingPartyId("");
  setters.setRelyingPartyName("");
  setters.setCredentialId("");
  setters.setCreationDate("");
  setters.setDeviceInfo("");
  setters.setShowCredentialId(false);
  setters.setAttachments([]);
  setters.setOrgFolderId(null);
  setters.setSaving(false);
}
