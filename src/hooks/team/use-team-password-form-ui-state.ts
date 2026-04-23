"use client";

import { useState } from "react";

export function useTeamPasswordFormUiState() {
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [showCredentialId, setShowCredentialId] = useState(false);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [showRoutingNumber, setShowRoutingNumber] = useState(false);
  const [showLicenseKey, setShowLicenseKey] = useState(false);

  return {
    values: {
      saving,
      showPassword,
      showGenerator,
      showCardNumber,
      showCvv,
      showIdNumber,
      showCredentialId,
      showAccountNumber,
      showRoutingNumber,
      showLicenseKey,
    },
    setters: {
      setSaving,
      setShowPassword,
      setShowGenerator,
      setShowCardNumber,
      setShowCvv,
      setShowIdNumber,
      setShowCredentialId,
      setShowAccountNumber,
      setShowRoutingNumber,
      setShowLicenseKey,
    },
  };
}
