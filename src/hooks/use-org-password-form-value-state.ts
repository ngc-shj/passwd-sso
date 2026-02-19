import { useState } from "react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";
import type { OrgPasswordFormInitialValues } from "@/hooks/use-org-password-form-state";

export function useOrgPasswordFormValueState(initial: OrgPasswordFormInitialValues) {
  const [title, setTitle] = useState(initial.title);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState(initial.password);
  const [content, setContent] = useState(initial.content);
  const [url, setUrl] = useState(initial.url);
  const [notes, setNotes] = useState(initial.notes);
  const [selectedTags, setSelectedTags] = useState<OrgTagData[]>(initial.selectedTags);
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(initial.generatorSettings);
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(initial.customFields);
  const [totp, setTotp] = useState<EntryTotp | null>(initial.totp);
  const [showTotpInput, setShowTotpInput] = useState(initial.showTotpInput);
  const [cardholderName, setCardholderName] = useState(initial.cardholderName);
  const [cardNumber, setCardNumber] = useState(initial.cardNumber);
  const [brand, setBrand] = useState(initial.brand);
  const [brandSource, setBrandSource] = useState<"auto" | "manual">(initial.brandSource);
  const [expiryMonth, setExpiryMonth] = useState(initial.expiryMonth);
  const [expiryYear, setExpiryYear] = useState(initial.expiryYear);
  const [cvv, setCvv] = useState(initial.cvv);
  const [fullName, setFullName] = useState(initial.fullName);
  const [address, setAddress] = useState(initial.address);
  const [phone, setPhone] = useState(initial.phone);
  const [email, setEmail] = useState(initial.email);
  const [dateOfBirth, setDateOfBirth] = useState(initial.dateOfBirth);
  const [nationality, setNationality] = useState(initial.nationality);
  const [idNumber, setIdNumber] = useState(initial.idNumber);
  const [issueDate, setIssueDate] = useState(initial.issueDate);
  const [expiryDate, setExpiryDate] = useState(initial.expiryDate);
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [relyingPartyId, setRelyingPartyId] = useState(initial.relyingPartyId);
  const [relyingPartyName, setRelyingPartyName] = useState(initial.relyingPartyName);
  const [credentialId, setCredentialId] = useState(initial.credentialId);
  const [creationDate, setCreationDate] = useState(initial.creationDate);
  const [deviceInfo, setDeviceInfo] = useState(initial.deviceInfo);
  const [orgFolderId, setOrgFolderId] = useState<string | null>(initial.orgFolderId);

  return {
    values: {
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
    },
    setters: {
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
    },
  };
}
