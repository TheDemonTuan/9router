import { requestChatGptWebRuntimeAdmin, validateChatGptWebProfileId } from "open-sse/services/chatgptWebRuntimeClient.js";

// Never reset an existing account's settings, revision, or browser epoch.
export async function ensureChatGptWebRuntimeProfile(profileId, signal) {
  validateChatGptWebProfileId(profileId);
  const list = await requestChatGptWebRuntimeAdmin("/admin/profiles", { signal }, { timeoutMs: 10000 });
  if (!list.ok) throw new Error("runtime_unavailable");
  const data = await list.json();
  if (!Array.isArray(data.profiles) || data.profiles.some(item => typeof item?.profileId !== "string")) throw new Error("invalid_runtime_response");
  if (data.profiles.some(item => item.profileId === profileId)) return;
  const created = await requestChatGptWebRuntimeAdmin("/admin/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId }), signal }, { timeoutMs: 70000 });
  if (!created.ok || (await created.json())?.profileId !== profileId) throw new Error("profile_provision_failed");
}
