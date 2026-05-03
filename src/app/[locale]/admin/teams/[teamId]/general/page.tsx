import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TeamGeneralPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const locale = await getLocale();
  redirect(`/${locale}/admin/teams/${teamId}/general/profile`);
}
