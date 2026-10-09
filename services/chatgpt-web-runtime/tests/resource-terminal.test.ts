import { expect, test } from "bun:test";
import { buildResponseJSON, bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* failedCapacity(): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: "partial" };
  yield { type: "error", message: "Runtime resource capacity wait timed out", status: 503,
    errorType: "runtime_error", code: "runtime_capacity_exceeded", retryable: false, submission_state: "unknown" };
}

test("post-Send capacity errors preserve unknown submission without a successful terminal", async () => {
  const events: AdapterEvent[] = [];
  for await (const event of failedCapacity()) events.push(event);
  const result = buildResponseJSON(events, "fixture-model");
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({ code: "runtime_capacity_exceeded", submission_state: "unknown" });
  const response = new Response(bridgeToResponsesSSE(failedCapacity(), "fixture-model"));
  const wire = await response.text();
  expect(wire).toContain('"submission_state":"unknown"');
  expect(wire).toContain("event: response.failed");
  expect(wire).not.toContain("event: response.completed");
});
