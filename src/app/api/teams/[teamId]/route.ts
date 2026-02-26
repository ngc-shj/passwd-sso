import type { NextRequest } from "next/server";
import * as OrgRoute from "@/app/api/orgs/[orgId]/route";

type Params = Promise<Record<string, string>>;

function mapParams(params: Params): Params {
  return params.then((p) => ({ ...p, orgId: p.teamId ?? p.orgId }));
}

export async function GET(req: NextRequest, ctx: { params: Params }) {
  const handler = (OrgRoute as Record<string, unknown>).GET as (
    req: NextRequest,
    ctx: { params: Params },
  ) => Promise<Response>;
  return handler(req, { params: mapParams(ctx.params) });
}

export async function PUT(req: NextRequest, ctx: { params: Params }) {
  const handler = (OrgRoute as Record<string, unknown>).PUT as (
    req: NextRequest,
    ctx: { params: Params },
  ) => Promise<Response>;
  return handler(req, { params: mapParams(ctx.params) });
}

export async function DELETE(req: NextRequest, ctx: { params: Params }) {
  const handler = (OrgRoute as Record<string, unknown>).DELETE as (
    req: NextRequest,
    ctx: { params: Params },
  ) => Promise<Response>;
  return handler(req, { params: mapParams(ctx.params) });
}
