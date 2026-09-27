import { NextResponse } from "next/server";
import { checkRtkConnection } from "open-sse/rtk/client.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function POST() {
  try {
    return NextResponse.json({ check: await checkRtkConnection() }, { headers });
  } catch {
    return NextResponse.json({ error: "rtk_check_unavailable" }, { status: 500, headers });
  }
}
