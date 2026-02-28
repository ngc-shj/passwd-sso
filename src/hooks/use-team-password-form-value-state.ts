import { useState } from "react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { TeamPasswordFormInitialValues } from "@/hooks/team-password-form-initial-values";

export function useTeamPasswordFormValueState(initial: TeamPasswordFormInitialValues) {
  const [title, setTitle] = useState(initial.title);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState(initial.password);
  const [content, setContent] = useState(initial.content);
  const [url, setUrl] = useState(initial.url);
  const [notes, setNotes] = useState(initial.notes);
  const [selectedTags, setSelectedTags] = useState<TeamTagData[]>(initial.selectedTags);
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
  const [bankName, setBankName] = useState(initial.bankName);
  const [accountType, setAccountType] = useState(initial.accountType);
  const [accountHolderName, setAccountHolderName] = useState(initial.accountHolderName);
  const [accountNumber, setAccountNumber] = useState(initial.accountNumber);
  const [routingNumber, setRoutingNumber] = useState(initial.routingNumber);
  const [swiftBic, setSwiftBic] = useState(initial.swiftBic);
  const [iban, setIban] = useState(initial.iban);
  const [branchName, setBranchName] = useState(initial.branchName);
  const [softwareName, setSoftwareName] = useState(initial.softwareName);
  const [licenseKey, setLicenseKey] = useState(initial.licenseKey);
  const [version, setVersion] = useState(initial.version);
  const [licensee, setLicensee] = useState(initial.licensee);
  const [purchaseDate, setPurchaseDate] = useState(initial.purchaseDate);
  const [expirationDate, setExpirationDate] = useState(initial.expirationDate);
  const [teamFolderId, setTeamFolderId] = useState<string | null>(initial.teamFolderId);
  const [requireReprompt, setRequireReprompt] = useState(initial.requireReprompt);
  const [expiresAt, setExpiresAt] = useState<string | null>(initial.expiresAt);

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
      bankName,
      accountType,
      accountHolderName,
      accountNumber,
      routingNumber,
      swiftBic,
      iban,
      branchName,
      softwareName,
      licenseKey,
      version,
      licensee,
      purchaseDate,
      expirationDate,
      teamFolderId,
      requireReprompt,
      expiresAt,
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
      setBankName,
      setAccountType,
      setAccountHolderName,
      setAccountNumber,
      setRoutingNumber,
      setSwiftBic,
      setIban,
      setBranchName,
      setSoftwareName,
      setLicenseKey,
      setVersion,
      setLicensee,
      setPurchaseDate,
      setExpirationDate,
      setTeamFolderId,
      setRequireReprompt,
      setExpiresAt,
    },
  };
}
