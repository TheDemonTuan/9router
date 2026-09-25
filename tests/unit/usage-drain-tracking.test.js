import { describe, expect, it } from "vitest";
import { trackPendingRequest, getActiveRequests } from "@/lib/db/repos/usageRepo.js";

describe("active request and stream drain tracking", () => {
  it("tracks streaming and non-streaming requests with oldest timestamp and handles full lifecycle", async () => {
    // 1. Initial idle
    let active = await getActiveRequests();
    expect(active.activeRequestsKnown).toBe(true);
    expect(active.liveActiveRequests).toEqual([]);

    // 2. Start a stream request
    trackPendingRequest("gpt-4o", "openai", "conn-1", true, false, { requestId: "req-1", stream: true });
    active = await getActiveRequests();
    expect(active.liveActiveRequests).toHaveLength(1);
    expect(active.liveActiveRequests[0].count).toBe(1);
    expect(active.activeStreams).toBe(1);
    expect(active.activeNonStream).toBe(0);
    expect(typeof active.oldestActiveMs).toBe("number");

    // 3. Start a non-stream request
    trackPendingRequest("claude-3-7-sonnet", "anthropic", "conn-2", true, false, { requestId: "req-2", stream: false });
    active = await getActiveRequests();
    expect(active.activeStreams).toBe(1);
    expect(active.activeNonStream).toBe(1);

    // 4. Stream disconnects / completes
    trackPendingRequest("gpt-4o", "openai", "conn-1", false, false, { requestId: "req-1", stream: true });
    active = await getActiveRequests();
    expect(active.activeStreams).toBe(0);
    expect(active.activeNonStream).toBe(1);

    // 5. Non-stream finishes
    trackPendingRequest("claude-3-7-sonnet", "anthropic", "conn-2", false, false, { requestId: "req-2", stream: false });
    active = await getActiveRequests();
    expect(active.activeStreams).toBe(0);
    expect(active.activeNonStream).toBe(0);
    expect(active.oldestActiveMs).toBeNull();
    expect(active.liveActiveRequests).toHaveLength(0);
  });

  it("handles fallback and error release gracefully without leaks", async () => {
    trackPendingRequest("gemini-2.5", "google", "conn-3", true, false);
    let active = await getActiveRequests();
    expect(active.liveActiveRequests[0].count).toBe(1);

    // Error release
    trackPendingRequest("gemini-2.5", "google", "conn-3", false, true);
    active = await getActiveRequests();
    expect(active.liveActiveRequests).toHaveLength(0);
    expect(active.activeStreams).toBe(0);
    expect(active.activeNonStream).toBe(0);
    expect(active.oldestActiveMs).toBeNull();
  });
});
