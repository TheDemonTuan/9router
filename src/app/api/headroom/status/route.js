import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "@/lib/headroom/detect";
import { getManagedPid } from "@/lib/headroom/process";
import { isLocalRequest } from "@/dashboardGuard";
import { buildCompressEndpoint, isSafeOrigin } from "open-sse/rtk/headroomGateway.js";
import { getHeadroomRuntimeSnapshot } from "open-sse/rtk/headroomRuntime.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const endpoint = buildCompressEndpoint(url);
    const runtime = getHeadroomRuntimeSnapshot(isSafeOrigin(endpoint) ? endpoint : null);
    const status = await getHeadroomStatus(url);
    const managedPid = getManagedPid();

    const isLocal = isLocalRequest(request);
    const serviceLocal = Boolean(status.localUrl);
    const rawDashboardAvailable = Boolean(isLocal && serviceLocal && status.running);
    const upstreamRuntime = status.compressionExecutor ? {
      compression_executor: status.compressionExecutor,
      observedAt: status.observedAt,
    } : null;

    if (!isLocal) {
      // Remote view excludes local process details and configured endpoint (which may contain credentials).
      return NextResponse.json({
        running: status.running,
        sidecarVersion: status.sidecarVersion || status.version || null,
        reachable: status.reachable,
        gatewaySupported: status.gatewaySupported,
        ready: status.ready,
        extras: status.extras,
        localUrl: false,
        rawDashboardAvailable: false,
        runtime,
        upstreamRuntime,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({
      ...status,
      localUrl: serviceLocal,
      rawDashboardAvailable,
      url,
      managedPid,
      runtime,
      upstreamRuntime,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
