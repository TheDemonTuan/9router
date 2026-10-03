import { extractApiKey, isValidApiKey } from "@/sse/services/auth.js";
import { chatGptWebAuthorityErrorResponse, loadChatGptWebClientKeys, verifyChatGptWebAuthority } from "@/lib/chatgptWebAuthority.js";
import { requestChatGptWebRuntime } from "open-sse/services/chatgptWebRuntimeClient.js";

export async function POST(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey || !await isValidApiKey(apiKey)) return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
  try {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength > 4096) return Response.json({ error: { code: "interrupt_body_too_large" } }, { status: 413 });
    const authority = verifyChatGptWebAuthority({ rawBody, method: request.method, path: new URL(request.url).pathname,
      headers: request.headers, clientKeys: await loadChatGptWebClientKeys() });
    if (authority.purpose !== "interrupt") return Response.json({ error: { code: "authority_purpose_mismatch" } }, { status: 400 });
    const response = await requestChatGptWebRuntime(null, "/v1/interrupt-turn", { method: "POST", signal: request.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ authority }) });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "x-9router-no-fallback": "true" } });
  } catch (error) { return chatGptWebAuthorityErrorResponse(error); }
}
