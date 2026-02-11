/**
 * Passphrase strength evaluation — shared between setup wizard and change dialog.
 * Returns level (0-4) and an i18n label key. Color is the caller's responsibility.
 */

export interface PassphraseStrength {
  level: 0 | 1 | 2 | 3 | 4;
  labelKey: string;
}

export function getStrength(passphrase: string): PassphraseStrength {
  if (!passphrase) return { level: 0, labelKey: "" };

  let score = 0;
  if (passphrase.length >= 10) score++;
  if (passphrase.length >= 16) score++;
  if (/[a-z]/.test(passphrase) && /[A-Z]/.test(passphrase)) score++;
  if (/[0-9]/.test(passphrase) || /[^a-zA-Z0-9]/.test(passphrase)) score++;

  const levels: PassphraseStrength[] = [
    { level: 1, labelKey: "strengthWeak" },
    { level: 2, labelKey: "strengthFair" },
    { level: 3, labelKey: "strengthGood" },
    { level: 4, labelKey: "strengthStrong" },
  ];

  return levels[Math.min(score, 3)];
}

/** Map strength level to Tailwind color class */
export const STRENGTH_COLORS = [
  "",
  "bg-red-500",
  "bg-orange-500",
  "bg-yellow-500",
  "bg-green-500",
];
