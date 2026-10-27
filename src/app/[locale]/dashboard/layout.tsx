import { redirect } from "@/i18n/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { auth } from "@/auth";
import { VaultGate } from "@/components/vault/vault-gate";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { PasskeyRequiredScreen } from "@/components/auth/passkey-required-screen";
import { SessionStateUnavailable } from "@/components/auth/session-state-unavailable";
import { passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";
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
    return redirect({ href: "/auth/signin", locale });
  }

  const messages = await getMessages();

  // Decided on the raw session fields with the server clock, never on the
  // display verdict `passkeyBlocked`. A degraded bundle (the passkey state
  // could not be read) is an outage and is checked first, so it never shows
  // the passkey screen to a tenant that does not require one. The blocked
  // branch replaces the vault gate and the shell: the minimal screen touches
  // no vault endpoint.
  let content: React.ReactNode;
  if (session.user.passkeyStateDegraded) {
    content = <SessionStateUnavailable />;
  } else if (passkeyEnforcementBlocks(session.user)) {
    content = <PasskeyRequiredScreen />;
  } else {
    content = (
      <VaultGate>
        <DashboardShell>{children}</DashboardShell>
      </VaultGate>
    );
  }

  return (
    <NextIntlClientProvider messages={pickMessages(messages, NS_DASHBOARD_ALL)}>
      {content}
    </NextIntlClientProvider>
  );
}
