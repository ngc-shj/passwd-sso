import { OrgExportPagePanel } from "@/components/team/team-export";

export default async function OrgExportPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <OrgExportPagePanel teamId={teamId} />;
}
