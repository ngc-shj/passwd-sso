import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { Toaster } from "@/components/ui/sonner";
import { detectBestLocaleFromAcceptLanguage } from "@/i18n/locale-utils";

export default async function ShareLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const locale = detectBestLocaleFromAcceptLanguage(
    headersList.get("accept-language")
  );
  const messages = (await import(`../../../messages/${locale}.json`)).default;

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
      <Toaster />
    </NextIntlClientProvider>
  );
}
