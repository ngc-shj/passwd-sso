import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { pickMessages } from "@/i18n/pick-messages";
import { NS_PRIVACY_POLICY } from "@/i18n/namespace-groups";

export default async function PrivacyPolicyLayout({
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
    <NextIntlClientProvider
      messages={pickMessages(messages, NS_PRIVACY_POLICY)}
    >
      {children}
    </NextIntlClientProvider>
  );
}
