import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/index.js";
import { RTK_CONFIG, RTK_FILTERS, RTK_LOCAL_FILTERS } from "open-sse/config/rtkConfig.js";
import { getRtkSnapshot } from "open-sse/rtk/state.js";
import { getRtkClientStatus } from "open-sse/rtk/client.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const settings = await getSettings();
    const client = getRtkClientStatus();
    return NextResponse.json({ ...getRtkSnapshot(), config: {
      enabled: settings.rtkEnabled !== false, endpointState: client.endpointState,
      minTextBytes: RTK_CONFIG.minTextBytes, maxTextBytes: RTK_CONFIG.maxTextBytes, requestMs: RTK_CONFIG.requestMs,
      sidecarFilters: RTK_FILTERS, localFilters: RTK_LOCAL_FILTERS,
    }, client }, { headers });
  } catch {
    return NextResponse.json({ error: "rtk_status_unavailable" }, { status: 500, headers });
  }
}
