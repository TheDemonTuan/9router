import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "@/lib/headroom/detect";
import { getManagedPid } from "@/lib/headroom/process";
import { isLocalRequest } from "@/dashboardGuard";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const status = await getHeadroomStatus(url);
    const managedPid = getManagedPid();

    if (!isLocalRequest(request)) {
      // Remote sanitized view: do not expose host filesystem paths, python interpreter or PID
      return NextResponse.json({
        running: status.running,
        sidecarVersion: status.sidecarVersion || status.version || null,
        reachable: status.reachable,
        gatewaySupported: status.gatewaySupported,
        ready: status.ready,
        extras: status.extras,
        url,
      });
    }

    return NextResponse.json({ ...status, url, managedPid });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
