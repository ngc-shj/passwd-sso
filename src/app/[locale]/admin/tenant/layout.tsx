import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getTenantRole, isTenantAdminRole } from "@/lib/auth/access/tenant-auth";

export default async function TenantAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const tenantRole = await getTenantRole(session.user.id);
  if (!isTenantAdminRole(tenantRole)) {
    notFound();
  }

  return <>{children}</>;
}
