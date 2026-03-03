import { WatchtowerPage } from "@/components/watchtower/watchtower-page";

export default async function TeamWatchtowerPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <WatchtowerPage scope={{ type: "team", teamId }} />;
}
