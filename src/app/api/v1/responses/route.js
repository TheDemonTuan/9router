import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { createPreResponseBudget } from "open-sse/utils/preResponseBudget.js";
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
  const budget = createPreResponseBudget({ clientSignal: request.signal });
  try {
    return await budget.run(async () => {
      await ensureInitialized();
      return await handleChat(request, null, { preResponse: budget });
    });
  } catch (error) {
    if (error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || error?.status === 504) {
      return new Response(JSON.stringify({
        error: { message: "Gateway timeout: pre-response budget exceeded", type: "gateway_timeout" }
      }), {
        status: 504,
        headers: {
          "content-type": "application/json",
          "x-9router-no-fallback": "true",
          "x-should-retry": "true"
        }
      });
    }
    throw error;
  } finally {
    budget.dispose();
  }
}
