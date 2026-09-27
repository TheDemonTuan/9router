import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export async function GET() {
  let ready = false;
  try {
    const db = await getAdapter();
    // ponytail: chỉ kiểm SQLite/schema cốt lõi; khi cần kiểm tính toàn vẹn dữ liệu, thêm probe có chi phí riêng.
    ready = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")?.name === "settings";
  } catch {
    // Do not expose database details to the monitor.
  }
  return NextResponse.json({ ready }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
