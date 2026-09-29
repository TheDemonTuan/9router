import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/index.js";
import { TOKEN_SAVER_CONFIG } from "open-sse/config/tokenSaverConfig.js";
import { getTokenSaverSnapshot } from "open-sse/token-saver/state.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({ ...getTokenSaverSnapshot(), config: {
      ...TOKEN_SAVER_CONFIG, sessionDedupMode: settings.sessionDedupMode,
    } }, { headers });
  } catch {
    return NextResponse.json({ error: "token_saver_status_unavailable" }, { status: 500, headers });
  }
}
