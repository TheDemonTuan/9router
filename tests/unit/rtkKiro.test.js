import { describe, it, expect } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";

const diff = "diff --git a/a b/a\n" + "+change\n".repeat(100);

describe("Kiro source tool results", () => {
  it("keeps orphan and error output byte-exact", async () => {
    const body = { conversationState: { history: [
      { assistantResponseMessage: { toolUses: [{ toolUseId: "a", name: "Bash", input: { command: "git diff" } }] } },
      { userInputMessage: { userInputMessageContext: { toolResults: [
        { toolUseId: "other", content: [{ text: diff }] },
        { toolUseId: "a", status: "error", content: [{ text: diff }] },
      ] } } },
    ] } };
    const stats = await compressMessages(body, true);
    expect(stats.hits).toEqual([]);
    expect(body.conversationState.history[1].userInputMessage.userInputMessageContext.toolResults.map(r => r.content[0].text)).toEqual([diff, diff]);
  });
});
