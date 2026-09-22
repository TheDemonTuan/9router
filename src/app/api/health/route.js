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
    instance_id: `${process.env.HOSTNAME || "9router"}-${process.pid}`,
    active_requests: activeRequests,
    active_requests_known: activeRequestsKnown,
  }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
