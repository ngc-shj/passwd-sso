import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { pickMessages } from "@/i18n/pick-messages";
import { NS_RECOVERY } from "@/i18n/namespace-groups";

export default async function RecoveryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pickMessages(messages, NS_RECOVERY)}>
      {children}
    </NextIntlClientProvider>
  );
}
