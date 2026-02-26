import type { NextRequest } from "next/server";
import * as OrgRoute from "@/app/api/orgs/[orgId]/passwords/[id]/restore/route";

type Params = Promise<Record<string, string>>;

function mapParams(params: Params): Params {
  return params.then((p) => ({ ...p, orgId: p.teamId ?? p.orgId }));
}

export async function POST(req: NextRequest, ctx: { params: Params }) {
  const handler = (OrgRoute as Record<string, unknown>).POST as (
    req: NextRequest,
    ctx: { params: Params },
  ) => Promise<Response>;
  return handler(req, { params: mapParams(ctx.params) });
}
