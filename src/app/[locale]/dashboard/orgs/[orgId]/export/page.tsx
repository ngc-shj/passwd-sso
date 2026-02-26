import { OrgExportPagePanel } from "@/components/team/team-export";

export default async function OrgExportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return <OrgExportPagePanel orgId={orgId} />;
}
