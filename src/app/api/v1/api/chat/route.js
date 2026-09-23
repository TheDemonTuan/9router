import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";
import { withPreResponseBudget } from "open-sse/utils/preResponseBudget.js";
import { withWireHeartbeat } from "open-sse/utils/streamHandler.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  return withPreResponseBudget(request, async (preResponse) => {
    await ensureInitialized();
    const clonedReq = request.clone();
    let modelName = "llama3.2";
    try {
      const body = await clonedReq.json();
      modelName = body.model || "llama3.2";
    } catch (error) {
      if (preResponse.signal.aborted) throw preResponse.signal.reason;
    }
    const response = await handleChat(request, null, { preResponse });
    return withWireHeartbeat(transformToOllama(response, modelName), { clientSignal: request.signal, format: "ndjson" });
  });
}

