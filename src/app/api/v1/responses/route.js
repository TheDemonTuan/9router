import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { withPreResponseBudget } from "open-sse/utils/preResponseBudget.js";
import { createTimingContext } from "@/sse/utils/timingContext.js";
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

/**
 * POST /v1/responses - OpenAI Responses API format
 * Now handled by translator pattern (openai-responses format auto-detected)
 */
export async function POST(request) {
  const timingContext = request?.timingContext || createTimingContext();
  if (request && !request.timingContext) request.timingContext = timingContext;
  return withPreResponseBudget(request, async (preResponse) => {
    await ensureInitialized();
    return handleChat(request, null, { preResponse, timingContext });
  });
}
