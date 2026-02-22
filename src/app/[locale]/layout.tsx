import type { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import {
  getMessages,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { notFound } from "next/navigation";
import { SessionProvider } from "@/components/providers/session-provider";
import { VaultProvider } from "@/lib/vault-context";
import { Toaster } from "@/components/ui/sonner";
import { routing } from "@/i18n/routing";
import { pickMessages } from "@/i18n/pick-messages";
import { NS_GLOBAL } from "@/i18n/namespace-groups";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    title: t("title"),
    description: t("description"),
  };
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pickMessages(messages, NS_GLOBAL)}>
      <SessionProvider>
        <VaultProvider>
          {children}
          <Toaster />
        </VaultProvider>
      </SessionProvider>
    </NextIntlClientProvider>
  );
}
