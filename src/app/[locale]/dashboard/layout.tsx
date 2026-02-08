import { redirect } from "@/i18n/navigation";
import { auth } from "@/auth";
import { setRequestLocale } from "next-intl/server";
import { VaultGate } from "@/components/vault/vault-gate";

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

  return <VaultGate>{children}</VaultGate>;
}
