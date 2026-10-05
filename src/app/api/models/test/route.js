import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { getProviderConnectionById } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind, connectionId } = await request.json();
    if (typeof model !== "string" || !model.trim()) return NextResponse.json({ error: "Model required" }, { status: 400 });
    if (connectionId !== undefined) {
      if (typeof connectionId !== "string" || !connectionId) return NextResponse.json({ ok: false, error: "Invalid connection ID" }, { status: 400 });
      const connection = await getProviderConnectionById(connectionId);
      if (!connection || connection.isActive === false || connection.provider !== resolveProviderId(model.split("/")[0])) {
        return NextResponse.json({ ok: false, error: "Selected connection is unavailable or does not match the model" }, { status: 400 });
      }
    }
    const result = await pingModelByKind(model, kind || "llm", undefined, { connectionId, signal: request.signal });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
