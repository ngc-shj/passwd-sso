import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { pickMessages } from "@/i18n/pick-messages";

/** Namespaces needed by the sign-in page client components. */
const NS_AUTH = ["Auth"] as const;

export default async function AuthLayout({
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
    <NextIntlClientProvider messages={pickMessages(messages, NS_AUTH)}>
      {children}
    </NextIntlClientProvider>
  );
}
