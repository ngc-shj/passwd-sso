import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getTenantRole } from "@/lib/tenant-auth";

export default async function TenantAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const tenantRole = await getTenantRole(session.user.id);
  if (!tenantRole) notFound();

  return <>{children}</>;
}
