import { OrgExportDialog } from "@/components/org/org-export-dialog";

export default async function OrgExportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  return <OrgExportDialog orgId={orgId} mode="page" />;
}

