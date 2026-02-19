"use client";

import { useState } from "react";

export function usePersonalPasswordFormUiState() {
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  return {
    values: {
      showPassword,
      showGenerator,
      submitting,
    },
    setters: {
      setShowPassword,
      setShowGenerator,
      setSubmitting,
    },
  };
}
