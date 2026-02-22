import { redirect } from "@/i18n/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { auth } from "@/auth";
import { VaultGate } from "@/components/vault/vault-gate";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { pickMessages } from "@/i18n/pick-messages";
import { NS_DASHBOARD_ALL } from "@/i18n/namespace-groups";

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await auth();

  if (!session?.user) {
    redirect({ href: "/auth/signin", locale });
  }

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pickMessages(messages, NS_DASHBOARD_ALL)}>
      <VaultGate>
        <DashboardShell>{children}</DashboardShell>
      </VaultGate>
    </NextIntlClientProvider>
  );
}
