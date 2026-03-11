"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ArrowLeft } from "lucide-react";

const LAST_UPDATED = "2026-03-11";

const SECTION_KEYS = [
  "overview",
  "dataCollection",
  "dataAccessed",
  "serverCommunication",
  "permissions",
  "security",
  "changes",
  "contact",
] as const;

const ITEM_SECTIONS: Record<string, readonly string[]> = {
  dataAccessed: ["storage", "activeTab", "clipboard", "forms"],
  permissions: [
    "storage",
    "alarms",
    "activeTab",
    "scripting",
    "contextMenus",
    "clipboardWrite",
    "offscreen",
    "hostPermissions",
  ],
};

export default function PrivacyPolicyPage() {
  const t = useTranslations("PrivacyPolicy");

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <Link
        href="/"
        className="mb-8 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToHome")}
      </Link>

      <h1 className="mb-2 text-3xl font-bold">{t("title")}</h1>
      <p className="mb-1 text-lg text-muted-foreground">{t("subtitle")}</p>
      <p className="mb-8 text-sm text-muted-foreground">
        {t("lastUpdated", { date: LAST_UPDATED })}
      </p>

      <div className="space-y-8">
        {SECTION_KEYS.map((key) => (
          <section key={key}>
            <h2 className="mb-3 text-xl font-semibold">
              {t(`sections.${key}.title`)}
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              {t(`sections.${key}.body`)}
            </p>
            {ITEM_SECTIONS[key] && (
              <ul className="mt-3 list-inside list-disc space-y-1 text-muted-foreground">
                {ITEM_SECTIONS[key].map((item) => (
                  <li key={item}>
                    <strong className="text-foreground">{item}</strong>
                    {" — "}
                    {t(`sections.${key}.items.${item}`)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
