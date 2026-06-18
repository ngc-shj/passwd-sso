import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import {
  JIT_TOKEN_TTL_MIN,
  JIT_TOKEN_TTL_MAX,
  DELEGATION_TTL_MIN,
  DELEGATION_TTL_MAX,
  LOCKOUT_DURATION_MIN,
  LOCKOUT_DURATION_MAX,
  PASSWORD_MAX_AGE_MIN,
  PASSWORD_MAX_AGE_MAX,
  PASSWORD_EXPIRY_WARNING_MIN,
  PASSWORD_EXPIRY_WARNING_MAX,
  AUDIT_LOG_RETENTION_MIN,
  AUDIT_LOG_RETENTION_MAX,
  RETENTION_DAYS_MIN,
  RETENTION_DAYS_MAX,
  SA_TOKEN_MAX_EXPIRY_MIN,
  SA_TOKEN_MAX_EXPIRY_MAX,
  PASSKEY_GRACE_PERIOD_MIN,
  PASSKEY_GRACE_PERIOD_MAX,
  PIN_LENGTH_MIN,
  PIN_LENGTH_MAX,
  LOCKOUT_THRESHOLD_MIN,
  LOCKOUT_THRESHOLD_MAX,
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  PASSWORD_HISTORY_COUNT_MAX,
  AUDIT_LOG_MAX_RANGE_DAYS,
} from "@/lib/validations/common";
import { CRYPTO_CONSTANTS } from "@/lib/crypto/crypto-client";

function readMessages(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, `${namespace}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

const LOCALES = ["en", "ja"] as const;

describe("TenantAdmin TTL help text interpolation", () => {
  for (const locale of LOCALES) {
    const messages = readMessages(locale, "TenantAdmin");
    const t = createTranslator({ locale, messages });

    it(`[${locale}] jitTokenDefaultTtlSecHelp renders min and max values`, () => {
      const result = t("jitTokenDefaultTtlSecHelp", { min: JIT_TOKEN_TTL_MIN, max: JIT_TOKEN_TTL_MAX });
      expect(result).toContain(String(JIT_TOKEN_TTL_MIN));
      expect(result).toContain(String(JIT_TOKEN_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] jitTokenMaxTtlSecHelp renders min and max values`, () => {
      const result = t("jitTokenMaxTtlSecHelp", { min: JIT_TOKEN_TTL_MIN, max: JIT_TOKEN_TTL_MAX });
      expect(result).toContain(String(JIT_TOKEN_TTL_MIN));
      expect(result).toContain(String(JIT_TOKEN_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] jitTokenTtlValidationMin renders min value`, () => {
      const result = t("jitTokenTtlValidationMin", { min: JIT_TOKEN_TTL_MIN });
      expect(result).toContain(String(JIT_TOKEN_TTL_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] jitTokenTtlValidationMax renders max value`, () => {
      const result = t("jitTokenTtlValidationMax", { max: JIT_TOKEN_TTL_MAX });
      expect(result).toContain(String(JIT_TOKEN_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationDefaultTtlSecHelp renders min and max values`, () => {
      const result = t("delegationDefaultTtlSecHelp", { min: DELEGATION_TTL_MIN, max: DELEGATION_TTL_MAX });
      expect(result).toContain(String(DELEGATION_TTL_MIN));
      expect(result).toContain(String(DELEGATION_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationMaxTtlSecHelp renders min and max values`, () => {
      const result = t("delegationMaxTtlSecHelp", { min: DELEGATION_TTL_MIN, max: DELEGATION_TTL_MAX });
      expect(result).toContain(String(DELEGATION_TTL_MIN));
      expect(result).toContain(String(DELEGATION_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationTtlValidationMin renders min value`, () => {
      const result = t("delegationTtlValidationMin", { min: DELEGATION_TTL_MIN });
      expect(result).toContain(String(DELEGATION_TTL_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] delegationTtlValidationMax renders max value`, () => {
      const result = t("delegationTtlValidationMax", { max: DELEGATION_TTL_MAX });
      expect(result).toContain(String(DELEGATION_TTL_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] lockoutDurationHelp renders min and max values`, () => {
      const result = t("lockoutDurationHelp", { min: LOCKOUT_DURATION_MIN, max: LOCKOUT_DURATION_MAX });
      expect(result).toContain(String(LOCKOUT_DURATION_MIN));
      expect(result).toContain(String(LOCKOUT_DURATION_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] lockoutDurationRange renders min and max values`, () => {
      const result = t("lockoutDurationRange", { min: LOCKOUT_DURATION_MIN, max: LOCKOUT_DURATION_MAX });
      expect(result).toContain(String(LOCKOUT_DURATION_MIN));
      expect(result).toContain(String(LOCKOUT_DURATION_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordMaxAgeDaysHelp renders min and max values`, () => {
      const result = t("passwordMaxAgeDaysHelp", { min: PASSWORD_MAX_AGE_MIN, max: PASSWORD_MAX_AGE_MAX });
      expect(result).toContain(String(PASSWORD_MAX_AGE_MIN));
      expect(result).toContain(String(PASSWORD_MAX_AGE_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordMaxAgeValidationMin renders min value`, () => {
      const result = t("passwordMaxAgeValidationMin", { min: PASSWORD_MAX_AGE_MIN });
      expect(result).toContain(String(PASSWORD_MAX_AGE_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordMaxAgeValidationMax renders max value`, () => {
      const result = t("passwordMaxAgeValidationMax", { max: PASSWORD_MAX_AGE_MAX });
      expect(result).toContain(String(PASSWORD_MAX_AGE_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordExpiryWarningDaysHelp renders min and max values`, () => {
      const result = t("passwordExpiryWarningDaysHelp", { min: PASSWORD_EXPIRY_WARNING_MIN, max: PASSWORD_EXPIRY_WARNING_MAX });
      expect(result).toContain(String(PASSWORD_EXPIRY_WARNING_MIN));
      expect(result).toContain(String(PASSWORD_EXPIRY_WARNING_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordExpiryWarningValidationMin renders min value`, () => {
      const result = t("passwordExpiryWarningValidationMin", { min: PASSWORD_EXPIRY_WARNING_MIN });
      expect(result).toContain(String(PASSWORD_EXPIRY_WARNING_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordExpiryWarningValidationMax renders max value`, () => {
      const result = t("passwordExpiryWarningValidationMax", { max: PASSWORD_EXPIRY_WARNING_MAX });
      expect(result).toContain(String(PASSWORD_EXPIRY_WARNING_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] auditLogRetentionDaysHelp renders min and max values`, () => {
      const result = t("auditLogRetentionDaysHelp", { min: AUDIT_LOG_RETENTION_MIN, max: AUDIT_LOG_RETENTION_MAX });
      expect(result).toContain(String(AUDIT_LOG_RETENTION_MIN));
      expect(result).toContain(String(AUDIT_LOG_RETENTION_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] auditLogRetentionValidationMin renders min value`, () => {
      const result = t("auditLogRetentionValidationMin", { min: AUDIT_LOG_RETENTION_MIN });
      expect(result).toContain(String(AUDIT_LOG_RETENTION_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] auditLogRetentionValidationMax renders max value`, () => {
      const result = t("auditLogRetentionValidationMax", { max: AUDIT_LOG_RETENTION_MAX });
      expect(result).toContain(String(AUDIT_LOG_RETENTION_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    for (const labelKey of [
      "trashRetention",
      "historyRetention",
      "shareAccessLogRetention",
      "directorySyncLogRetention",
      "notificationRetention",
    ] as const) {
      it(`[${locale}] ${labelKey}DaysHelp renders min and max values`, () => {
        const result = t(`${labelKey}DaysHelp`, { min: RETENTION_DAYS_MIN, max: RETENTION_DAYS_MAX });
        expect(result).toContain(String(RETENTION_DAYS_MIN));
        expect(result).toContain(String(RETENTION_DAYS_MAX));
        expect(result).not.toContain("{");
        expect(result).not.toContain("}");
      });

      it(`[${locale}] ${labelKey}ValidationMin renders min value`, () => {
        const result = t(`${labelKey}ValidationMin`, { min: RETENTION_DAYS_MIN });
        expect(result).toContain(String(RETENTION_DAYS_MIN));
        expect(result).not.toContain("{");
        expect(result).not.toContain("}");
      });

      it(`[${locale}] ${labelKey}ValidationMax renders max value`, () => {
        const result = t(`${labelKey}ValidationMax`, { max: RETENTION_DAYS_MAX });
        expect(result).toContain(String(RETENTION_DAYS_MAX));
        expect(result).not.toContain("{");
        expect(result).not.toContain("}");
      });
    }

    it(`[${locale}] saTokenMaxExpiryDaysHelp renders min and max values`, () => {
      const result = t("saTokenMaxExpiryDaysHelp", { min: SA_TOKEN_MAX_EXPIRY_MIN, max: SA_TOKEN_MAX_EXPIRY_MAX });
      expect(result).toContain(String(SA_TOKEN_MAX_EXPIRY_MIN));
      expect(result).toContain(String(SA_TOKEN_MAX_EXPIRY_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] saTokenMaxExpiryValidationMin renders min value`, () => {
      const result = t("saTokenMaxExpiryValidationMin", { min: SA_TOKEN_MAX_EXPIRY_MIN });
      expect(result).toContain(String(SA_TOKEN_MAX_EXPIRY_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] saTokenMaxExpiryValidationMax renders max value`, () => {
      const result = t("saTokenMaxExpiryValidationMax", { max: SA_TOKEN_MAX_EXPIRY_MAX });
      expect(result).toContain(String(SA_TOKEN_MAX_EXPIRY_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passkeyGracePeriodValidationMin renders min value`, () => {
      const result = t("passkeyGracePeriodValidationMin", { min: PASSKEY_GRACE_PERIOD_MIN });
      expect(result).toContain(String(PASSKEY_GRACE_PERIOD_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passkeyGracePeriodValidationMax renders max value`, () => {
      const result = t("passkeyGracePeriodValidationMax", { max: PASSKEY_GRACE_PERIOD_MAX });
      expect(result).toContain(String(PASSKEY_GRACE_PERIOD_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] requireMinPinLengthHelp renders min and max values`, () => {
      const result = t("requireMinPinLengthHelp", { min: PIN_LENGTH_MIN, max: PIN_LENGTH_MAX });
      expect(result).toContain(String(PIN_LENGTH_MIN));
      expect(result).toContain(String(PIN_LENGTH_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passkeyMinPinLengthValidationMin renders min value`, () => {
      const result = t("passkeyMinPinLengthValidationMin", { min: PIN_LENGTH_MIN });
      expect(result).toContain(String(PIN_LENGTH_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passkeyMinPinLengthValidationMax renders max value`, () => {
      const result = t("passkeyMinPinLengthValidationMax", { max: PIN_LENGTH_MAX });
      expect(result).toContain(String(PIN_LENGTH_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] lockoutThresholdHelp renders min and max values`, () => {
      const result = t("lockoutThresholdHelp", { min: LOCKOUT_THRESHOLD_MIN, max: LOCKOUT_THRESHOLD_MAX });
      expect(result).toContain(String(LOCKOUT_THRESHOLD_MIN));
      expect(result).toContain(String(LOCKOUT_THRESHOLD_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] lockoutThresholdRange renders min and max values`, () => {
      const result = t("lockoutThresholdRange", { min: LOCKOUT_THRESHOLD_MIN, max: LOCKOUT_THRESHOLD_MAX });
      expect(result).toContain(String(LOCKOUT_THRESHOLD_MIN));
      expect(result).toContain(String(LOCKOUT_THRESHOLD_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] tenantMinPasswordLengthHelp renders min and max values`, () => {
      const result = t("tenantMinPasswordLengthHelp", { min: POLICY_MIN_PW_LENGTH_MIN, max: POLICY_MIN_PW_LENGTH_MAX });
      // min is 0, but the static "Set to 0 to disable" / "0で無効化" copy also
      // contains "0", so asserting toContain("0") would pass vacuously. The
      // brace-residue guards below are the real protection for the min slot.
      expect(result).toContain(String(POLICY_MIN_PW_LENGTH_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordMinLengthValidationMin renders min value`, () => {
      const result = t("passwordMinLengthValidationMin", { min: POLICY_MIN_PW_LENGTH_MIN });
      expect(result).toContain(String(POLICY_MIN_PW_LENGTH_MIN));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordMinLengthValidationMax renders max value`, () => {
      const result = t("passwordMinLengthValidationMax", { max: POLICY_MIN_PW_LENGTH_MAX });
      expect(result).toContain(String(POLICY_MIN_PW_LENGTH_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });
  }
});

describe("TeamPolicy range/help text interpolation", () => {
  for (const locale of LOCALES) {
    const messages = readMessages(locale, "TeamPolicy");
    const t = createTranslator({ locale, messages });

    it(`[${locale}] minPasswordLengthRange renders min and max values`, () => {
      const result = t("minPasswordLengthRange", { min: POLICY_MIN_PW_LENGTH_MIN, max: POLICY_MIN_PW_LENGTH_MAX });
      expect(result).toContain(String(POLICY_MIN_PW_LENGTH_MIN));
      expect(result).toContain(String(POLICY_MIN_PW_LENGTH_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordHistoryCountHelp renders max value`, () => {
      const result = t("passwordHistoryCountHelp", { max: PASSWORD_HISTORY_COUNT_MAX });
      expect(result).toContain(String(PASSWORD_HISTORY_COUNT_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });

    it(`[${locale}] passwordHistoryCountRange renders min and max values`, () => {
      const result = t("passwordHistoryCountRange", { min: 0, max: PASSWORD_HISTORY_COUNT_MAX });
      expect(result).toContain(String(PASSWORD_HISTORY_COUNT_MAX));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });
  }
});

describe("AuditDownload interpolation", () => {
  for (const locale of LOCALES) {
    const messages = readMessages(locale, "AuditDownload");
    const t = createTranslator({ locale, messages });

    it(`[${locale}] maxRange renders max value`, () => {
      const result = t("maxRange", { max: AUDIT_LOG_MAX_RANGE_DAYS });
      expect(result).toContain(String(AUDIT_LOG_MAX_RANGE_DAYS));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });
  }
});

describe("PrivacyPolicy security section PBKDF2 iterations interpolation", () => {
  // PBKDF2_ITERATIONS via CRYPTO_CONSTANTS (which references crypto-params.ts).
  // Direct import from @/lib/crypto/crypto-params also valid — see deviation D4.
  const PBKDF2_ITERATIONS = CRYPTO_CONSTANTS.PBKDF2_ITERATIONS;

  for (const locale of LOCALES) {
    const rawMessages = readMessages(locale, "PrivacyPolicy");
    // sections is a nested object; createTranslator needs flat messages or supports nesting
    const t = createTranslator({ locale, messages: { PrivacyPolicy: rawMessages }, namespace: "PrivacyPolicy" });

    it(`[${locale}] sections.security.body renders PBKDF2 iterations without placeholder residue`, () => {
      const result = t("sections.security.body", { iterations: PBKDF2_ITERATIONS });
      // Rendered number must appear, formatted for the current locale
      expect(result).toContain(new Intl.NumberFormat(locale).format(PBKDF2_ITERATIONS));
      expect(result).not.toContain("{");
      expect(result).not.toContain("}");
    });
  }
});
