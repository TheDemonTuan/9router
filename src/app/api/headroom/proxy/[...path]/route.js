import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { isLocalRequest } from "@/dashboardGuard";

export const dynamic = "force-dynamic";

const REMOTE_ALLOWED_PATHS = new Set([
  "health",
  "readyz",
  "stats",
  "stats-history",
]);

const LOCAL_EXTENDED_PATHS = new Set([
  "dashboard",
  "transformations/feed",
]);

const SAFE_QUERY_PARAMS = new Set([
  "limit",
  "offset",
  "hours",
  "format",
]);

const PROXY_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB limit

async function getTargetBase() {
  const settings = await getSettings();
  const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Headroom URL must use http or https");
  }
  if (target.username || target.password) {
    throw new Error("Headroom URL must not contain user credentials");
  }
  return target;
}

function buildCleanTargetUrl(base, pathSegments, searchParams) {
  const target = new URL(base);
  const cleanPath = pathSegments.map((s) => encodeURIComponent(s)).join("/");
  target.pathname = `/${cleanPath}`;

  // Filter query parameters against safe allowlist
  const cleanSearch = new URLSearchParams();
  for (const [key, val] of searchParams.entries()) {
    if (SAFE_QUERY_PARAMS.has(key.toLowerCase())) {
      cleanSearch.set(key, val);
    }
  }
  target.search = cleanSearch.toString();
  return target;
}

async function proxy(request, { params }) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const rawSegments = (await params).path || [];
    const normalizedPath = rawSegments.join("/");

    const isLocal = isLocalRequest(request);
    const isRemoteAllowed = REMOTE_ALLOWED_PATHS.has(normalizedPath);
    const isLocalAllowed = isLocal && LOCAL_EXTENDED_PATHS.has(normalizedPath);

    if (!isRemoteAllowed && !isLocalAllowed) {
      return NextResponse.json(
        { error: "Endpoint not permitted through diagnostic proxy" },
        { status: 403 }
      );
    }

    const base = await getTargetBase();
    const reqUrl = new URL(request.url);
    const target = buildCleanTargetUrl(base, rawSegments, reqUrl.searchParams);

    // Fresh allowlisted request headers: do not forward client auth/cookies
    const upstreamHeaders = {
      "Accept": "application/json, text/plain",
      "User-Agent": "9Router-Headroom-Proxy/1.0",
    };

    const proxyToken = process.env.HEADROOM_PROXY_TOKEN;
    if (proxyToken) {
      upstreamHeaders["X-Headroom-Proxy-Token"] = proxyToken;
    }

    const response = await fetch(target, {
      method,
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      return NextResponse.json({ error: "Upstream redirect rejected" }, { status: 502 });
    }

    // Clean response headers: strip Set-Cookie, CORS headers, add no-store
    const outHeaders = new Headers();
    outHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
    outHeaders.set("Pragma", "no-cache");

    const contentType = response.headers.get("content-type");
    if (contentType) {
      outHeaders.set("Content-Type", contentType);
    }

    // For local-only raw dashboard html rewrite
    if (normalizedPath === "dashboard" && contentType?.includes("text/html")) {
      const html = await response.text();
      const rewritten = html.replace(
        /fetch\('(?=\/(?:stats|health|stats-history|transformations\/feed))/g,
        "fetch('/api/headroom/proxy/"
      );
      outHeaders.set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' /api/headroom/proxy/; img-src 'self' data:; frame-ancestors 'none';");
      outHeaders.set("X-Frame-Options", "DENY");
      outHeaders.set("X-Content-Type-Options", "nosniff");
      return new NextResponse(rewritten, { status: response.status, headers: outHeaders });
    }

    // Stream or buffer response with byte limit
    const bodyBuf = await response.arrayBuffer();
    if (bodyBuf.byteLength > MAX_RESPONSE_BYTES) {
      return NextResponse.json({ error: "Upstream payload exceeded resource limit" }, { status: 502 });
    }

    return new NextResponse(bodyBuf, { status: response.status, headers: outHeaders });
  } catch (error) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}

export const GET = proxy;
export const HEAD = proxy;
