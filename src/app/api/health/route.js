import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getActiveRequests } from "@/lib/usageDb";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

const instanceId = globalThis.__ninerouterInstanceId
  || (globalThis.__ninerouterInstanceId = process.env.NINEROUTER_INSTANCE_ID || randomUUID());

function responseSnapshot() {
  const state = globalThis.__ninerouterDrainResponses;
  if (!state || state.known !== true || !Number.isInteger(state.active) || state.active < 0) {
    return { active: null, known: false, entries: [] };
  }
  return { active: state.active, known: true, entries: state.entries instanceof Map ? [...state.entries.values()] : [] };
}

function isLoopback(value) {
  const host = String(value || "").trim().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "::1" || host === "127.0.0.1" || host === "::ffff:127.0.0.1") return true;
  return host.split(":")[0] === "127.0.0.1";
}

function canReadDetails(request) {
  if (!hasTrustedPeerHeaders(request)) return false;
  if (request.headers.get("x-9r-via-proxy")) return false;
  return isLoopback(request.headers.get("x-9r-real-ip"));
}

export async function GET(request) {
  const active = await getActiveRequests().catch(() => null);
  const liveRows = active?.liveActiveRequests;
  const activeRequestsKnown = active?.activeRequestsKnown === true
    && Array.isArray(liveRows)
    && liveRows.every((row) => Number.isInteger(row?.count) && row.count >= 0);
  const activeRequests = activeRequestsKnown
    ? liveRows.reduce((total, row) => total + row.count, 0)
    : null;
  const responses = responseSnapshot();
  const body = {
    ok: true,
    instance_id: instanceId,
    drain_contract_version: 2,
    active_requests: activeRequests,
    active_requests_known: activeRequestsKnown,
    active_responses: responses.active,
    active_responses_known: responses.known,
    oldest_active_request_ms: active?.oldestActiveRequestMs ?? null,
  };

  const details = new URL(request?.url || "http://localhost/api/health").searchParams.get("details") === "1";
  if (details && !canReadDetails(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS_HEADERS });
  }
  if (details) {
    body.active_requests_details = Array.isArray(active?.activeRequestDetails) ? active.activeRequestDetails : [];
    body.active_responses_details = responses.entries.map(({ id, startedAt }) => ({
      id,
      startedAt,
      ageMs: Math.max(0, Date.now() - startedAt),
    }));
  }

  return NextResponse.json(body, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
