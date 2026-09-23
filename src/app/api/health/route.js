import os from "node:os";
import { NextResponse } from "next/server";
import { getActiveRequests } from "@/lib/usageDb";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  const active = await getActiveRequests().catch(() => null);
  const liveRows = active?.liveActiveRequests;
  const activeRequestsKnown = active?.activeRequestsKnown === true
    && Array.isArray(liveRows)
    && liveRows.every((row) => Number.isInteger(row?.count) && row.count >= 0);
  const activeRequests = activeRequestsKnown
    ? liveRows.reduce((total, row) => total + row.count, 0)
    : null;
  return NextResponse.json({
    ok: true,
    instance_id: `${os.hostname()}-${process.pid}`,
    deployment_slot: process.env.DEPLOY_SLOT || null,
    active_requests: activeRequests,
    active_requests_known: activeRequestsKnown,
  }, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
