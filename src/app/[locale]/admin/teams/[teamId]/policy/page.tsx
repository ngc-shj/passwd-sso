import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TeamPolicyPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const locale = await getLocale();
  redirect(`/${locale}/admin/teams/${teamId}/policy/password`);
}
