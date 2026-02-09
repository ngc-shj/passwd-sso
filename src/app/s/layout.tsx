import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { Toaster } from "@/components/ui/sonner";
import { routing } from "@/i18n/routing";

function detectLocale(acceptLanguage: string | null): "ja" | "en" {
  if (!acceptLanguage) return routing.defaultLocale;
  const preferred = acceptLanguage.split(",")[0]?.split(";")[0]?.trim().toLowerCase();
  if (preferred?.startsWith("en")) return "en";
  return routing.defaultLocale;
}

export default async function ShareLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const locale = detectLocale(headersList.get("accept-language"));
  const messages = (await import(`../../../messages/${locale}.json`)).default;

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
      <Toaster />
    </NextIntlClientProvider>
  );
}
