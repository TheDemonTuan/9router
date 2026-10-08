"use client";

import Button from "./Button";
import Select from "./Select";
import Toggle from "./Toggle";
export default function ChatGPTWebPreferencesTab({ draft, change, disabled, biggerSupported, dirty, conflict, saving, save, reload }) {
  return <div className="space-y-4">
    <p className="text-sm text-text-muted">Generic API rounds send full history in a fresh temporary conversation. Retain and Saved below apply to the native Codex path, not generic API tool-result rounds.</p>
    {conflict && <div role="alert" className="space-y-2 text-sm text-amber-500"><p>The runtime revision changed. Your draft is preserved; nothing was overwritten.</p><Button variant="secondary" disabled={disabled} onClick={reload}>Reload latest preferences (discard draft)</Button></div>}
    <Toggle label="Bigger Context" checked={draft.experimentalBiggerContext} onChange={value => change("experimentalBiggerContext", value)} disabled={disabled || !biggerSupported} description="Verified supported Sol/Pro routes only. Multipart staging adds latency and context, not per-message capacity. Luna does not use multipart." />
    <Select label="Native conversation mode" aria-label="Native conversation mode" value={draft.experimentalFreshConversationPerTurn ? "fresh" : "retain"} options={[{ value: "retain", label: "Retain" }, { value: "fresh", label: "New each turn" }]} onChange={event => change("experimentalFreshConversationPerTurn", event.target.value === "fresh")} disabled={disabled} hint="Native tool-result rounds remain in the active conversation." />
    <Select label="Native chat storage" aria-label="Native chat storage" value={draft.useSavedChats ? "saved" : "temporary"} options={[{ value: "temporary", label: "Temporary" }, { value: "saved", label: "Saved" }]} onChange={event => change("useSavedChats", event.target.value === "saved")} disabled={disabled} hint="Saved chats may apply ChatGPT Memory and custom instructions." />
    <Toggle label="Approve one-time ChatGPT connector prompts" checked={draft.autoApproveToolCalls} onChange={value => change("autoApproveToolCalls", value)} disabled={disabled || draft.mode !== "full"} description="Only Allow once for the active Codex Native2 connector, never Allow always. The outer agent’s sandbox and approval policy still apply." />
    <Button disabled={disabled || !dirty || conflict} loading={saving} onClick={save}>Save preferences</Button>
    <p className="text-xs text-text-muted">Preferences belong to this runtime profile. Enabling coding tools is a separate verified action in Coding agents.</p>
  </div>;
}
