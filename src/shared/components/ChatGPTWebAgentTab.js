"use client";

import { useState } from "react";
import Button from "./Button";
import Input from "./Input";
import Select from "./Select";

function Snippet({ label, text, filename, copy, download }) {
  if (!text) return null;
  return <div className="space-y-2"><h4 className="text-sm font-medium">{label}</h4><pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs"><code>{text}</code></pre><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => copy(text)}>Copy</Button>{filename && <Button size="sm" variant="secondary" onClick={() => download(filename, text)}>Download {filename}</Button>}</div></div>;
}
export default function ChatGPTWebAgentTab({ profile, harness, disabled, busy, tunnelId, runtimeApiKey, onTunnelIdChange, onKeyChange, saveConfig, discardConfig, startTunnel, verifyConnector, activate, disconnect, openBrowser, waiting, endBrowser, setupOpen, openSetup, models, modelId, selectModel, effort, selectEffort, clientConfig, configError, copy, download, snippetNotice }) {
  const [selectedClient, setSelectedClient] = useState("omp");
  const sessionReady = profile?.state === "ready" && profile.models.length > 0;
  const full = profile?.settings.mode === "full";
  const operator = harness?.source === "operator";
  const step = !sessionReady ? 1 : !harness?.keyConfigured ? 2 : harness.tunnelState !== "ready" ? 3 : harness.connectorState !== "verified" ? 4 : !full ? 5 : 6;
  const currentModel = models.find(model => model.id === modelId);
  const snippets = { copy, download };
  const genericToolsReady = full && currentModel?.capabilities?.generic_tools === true;
  const tunnelForm = operator ? <p className="text-sm text-amber-500">Operator-managed tunnel. Dashboard cannot replace its key. Ask the operator to migrate provisioning before using managed setup.</p> : <div className="space-y-3"><p className="text-xs text-text-muted">Create a tunnel and Runtime API key in <a href="https://platform.openai.com/settings/organization/tunnels" target="_blank" rel="noopener noreferrer" className="text-brand-500 underline">Platform Tunnels</a> and <a href="https://platform.openai.com/settings/organization/api-keys" target="_blank" rel="noopener noreferrer" className="text-brand-500 underline">Runtime API keys</a>. Read + Use rights are separate from ChatGPT workspace/app permissions. Do not use an admin key, 9Router key or ChatGPT cookie.</p><Input label="Tunnel ID" aria-label="Tunnel ID" value={tunnelId} onChange={onTunnelIdChange} disabled={disabled} placeholder="tunnel_…" autoComplete="off" /><Input type="password" aria-label="Runtime API key" label={harness?.keyConfigured ? "Runtime API key (leave blank to keep saved key)" : "Runtime API key"} value={runtimeApiKey} onChange={onKeyChange} disabled={disabled} autoComplete="new-password" /><p className="text-xs text-text-muted">Secrets are saved only in the runtime. The key field clears after submission, error, tab change or close.</p><Button variant={step === 2 ? "primary" : "secondary"} disabled={disabled || !tunnelId.trim() || (!harness?.keyConfigured && !runtimeApiKey.trim())} loading={busy === "Save tunnel configuration"} onClick={saveConfig}>Save tunnel configuration</Button></div>;
  const configDirty = !!runtimeApiKey || (!!harness && tunnelId !== (harness.tunnelId || ""));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">Coding tools</h3><p className="text-sm text-text-muted">{full && harness?.canEnableFull ? "Enabled and verified by the runtime" : "Not ready until runtime verification passes"}</p></div>{!harness?.canEnableFull ? !setupOpen && <Button disabled={!!busy} onClick={openSetup}>Set up coding tools</Button> : !full && <Button disabled={disabled} loading={busy === "Enable coding tools"} onClick={activate}>Enable coding tools</Button>}</div>
    {configDirty && <div className="flex flex-wrap items-center gap-3 text-sm text-amber-500"><p>Tunnel configuration has unsaved changes.</p><Button variant="secondary" disabled={!!busy} onClick={discardConfig}>Discard tunnel draft</Button></div>}
    {setupOpen && <section aria-label="Harness setup" className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-xs text-text-muted">Setup and verification send zero model prompts. A tunnel does not grant ChatGPT workspace permissions or verify client execution.</p>
      {!harness && <p role="status" className="text-sm text-text-muted">Loading harness prerequisites…</p>}
      {harness && !harness.buildCompatible && <p role="alert" className="text-sm text-amber-500">This runtime build has not passed harness compatibility checks. Contact the operator; dashboard settings cannot manufacture compatibility evidence.</p>}
      {harness?.lastError && <p role="status" className="text-sm text-amber-500">{harness.lastError.message}</p>}
      <ol className="space-y-2">
        <li className="rounded-lg bg-surface-2 p-3"><p className="text-sm font-medium">1. Verify session {step > 1 ? "✓" : ""}</p>{step === 1 && <p className="mt-2 text-sm text-text-muted">Sign in and verify the saved session in Connection before enabling coding tools.</p>}</li>
        <li className="space-y-3 rounded-lg bg-surface-2 p-3"><p className="text-sm font-medium">2. Configure private tunnel {harness?.keyConfigured ? "✓" : ""}</p>{step === 2 && tunnelForm}</li>
        <li className="space-y-3 rounded-lg bg-surface-2 p-3"><p className="text-sm font-medium">3. Start tunnel {harness?.tunnelState === "ready" ? "✓" : ""}</p>{step === 3 && <><p className="text-xs text-text-muted">Start before adding the ChatGPT app so it can discover this runtime’s MCP actions.</p><Button disabled={disabled || !harness?.keyConfigured || !harness?.buildCompatible} loading={busy === "Start tunnel"} onClick={startTunnel}>Start tunnel</Button></>}</li>
        <li className="space-y-3 rounded-lg bg-surface-2 p-3">
          <p className="text-sm font-medium">4. Install and verify Codex Native2 {harness?.connectorState === "verified" ? "✓" : ""}</p>
          {step === 4 && <>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Open the private ChatGPT browser → Plugins → + → Add custom MCP server.</li>
              <li>Choose Tunnel and <code className="break-all">{harness.tunnelId}</code>; Create as a plugin named <strong>Codex Native2</strong>, then install it. Authentication None is only for this private tunnel.</li>
              <li>Review actions and read/write permissions. Existing installations must refresh/review/publish actions to include <code>router_submit_tool_calls</code>; an app name alone does not prove the new action is installed.</li>
            </ol>
            <details><summary className="cursor-pointer text-xs">Older ChatGPT surface or permission blocker</summary><p className="mt-2 text-xs text-text-muted">Use Apps / Developer Mode if that is your workspace’s surface. Missing custom MCP or write permissions is a workspace/plan blocker; stay browser-only rather than bypassing consent. See <a href="https://developers.openai.com/api/docs/guides/custom-mcp-server" target="_blank" rel="noopener noreferrer" className="underline">official MCP setup</a> and <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target="_blank" rel="noopener noreferrer" className="underline">Developer Mode</a>.</p></details>
            <Button variant="secondary" disabled={!!busy} onClick={openBrowser}>Open private browser</Button>
            {waiting && <><p className="text-xs text-text-muted">Finish the private browser setup session before connector verification.</p><Button variant="secondary" disabled={!!busy} onClick={endBrowser}>Finish browser setup</Button></>}
            <Button disabled={disabled} loading={busy === "Verify connector"} onClick={verifyConnector}>Verify connector (zero-Send)</Button>
          </>}
        </li>
        <li className="space-y-3 rounded-lg bg-surface-2 p-3"><p className="text-sm font-medium">5. Enable coding tools {full ? "✓" : ""}</p>{step === 5 && <p className="text-xs text-text-muted">Use Enable coding tools above only after runtime verification. No model prompt is sent; catalog readiness is checked after activation.</p>}</li>
        <li className="rounded-lg bg-surface-2 p-3"><p className="text-sm font-medium">6. Configure your client {step === 6 ? "— choose a path below" : ""}</p></li>
      </ol>
    </section>}
    {harness?.keyConfigured && <details className="space-y-3"><summary className="cursor-pointer text-sm">Review or update tunnel configuration</summary><p className="break-all text-xs text-text-muted">Source: {harness.source} · Tunnel: {harness.tunnelId} · Config revision: {harness.configRevision}</p>{tunnelForm}</details>}
    {models.length > 0 && <div className="grid gap-3 sm:grid-cols-2"><Select label="Verified model" aria-label="Verified model" value={modelId} options={models.map(model => ({ value: model.id, label: model.display_name || model.id }))} onChange={selectModel} /><Select label="Reasoning effort" aria-label="Reasoning effort" value={effort} options={(currentModel?.supported_reasoning_levels || []).map(value => ({ value, label: value }))} onChange={selectEffort} /></div>}
    {configError && <p role="status" className="text-sm text-amber-500">{configError}</p>}
    {snippetNotice && <p role="status" className="text-sm text-text-muted">{snippetNotice}</p>}
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Client setup</h3>
          <p className="text-xs text-text-muted">
            {genericToolsReady ? "Coding tools ready · executed by omp" : "Text only · enable coding tools to use local tools"}
          </p>
        </div>
        <div className="w-56">
          <Select
            label="Client"
            aria-label="Select coding agent client"
            value={selectedClient}
            options={[
              { value: "omp", label: "omp (recommended)" },
              { value: "opencode", label: "OpenCode" },
              { value: "other", label: "Other OpenAI-compatible" },
            ]}
            onChange={event => setSelectedClient(event.target.value)}
          />
        </div>
        {!genericToolsReady && <Button size="sm" variant="secondary" disabled={!!busy} onClick={openSetup}>Set up coding tools</Button>}
      </div>
      <p className="text-xs text-text-muted">Your client controls tool execution and approvals.</p>
      {selectedClient === "omp" && clientConfig && (
        <div className="space-y-3">
          <div className="rounded-lg bg-surface-2 p-3 space-y-2">
            <p className="text-sm font-medium">1. API key</p>
            <p className="text-xs text-text-muted">Set your 9Router API key in the environment.</p>
            <pre className="overflow-auto rounded bg-surface p-2 text-xs"><code>export NINE_ROUTER_API_KEY=&apos;&lt;your-9router-api-key&gt;&apos;</code></pre>
            <Button size="sm" variant="secondary" onClick={() => copy("export NINE_ROUTER_API_KEY='<your-9router-api-key>'")}>Copy command</Button>
          </div>
          <div className="rounded-lg bg-surface-2 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">2. Add provider to ~/.omp/agent/models.yml</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => copy(clientConfig.ompConfig)}>Copy config</Button>
                <Button size="sm" variant="secondary" onClick={() => download("models.yml", clientConfig.ompConfig)}>Download models.yml</Button>
              </div>
            </div>
            <p className="text-xs text-text-muted">Merge under the existing providers root in ~/.omp/agent/models.yml, or edit models.yaml if that is your active file. If 9router-cgw exists, merge this model by id. Preserve all other models/providers; do not overwrite your configuration.</p>
            <details>
              <summary className="cursor-pointer text-xs font-medium">View config</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface p-2 text-xs"><code>{clientConfig.ompConfig}</code></pre>
            </details>
          </div>
          <div className="rounded-lg bg-surface-2 p-3 space-y-2">
            <p className="text-sm font-medium">3. Start omp</p>
            <pre className="overflow-auto rounded bg-surface p-2 text-xs"><code>{clientConfig.ompCommand}</code></pre>
            <Button size="sm" variant="secondary" onClick={() => copy(clientConfig.ompCommand)}>Copy command</Button>
          </div>
        </div>
      )}
      {selectedClient === "opencode" && clientConfig && (
        <div className="space-y-3">
          <details className="space-y-3" open={false}>
            <summary className="cursor-pointer text-sm font-medium">OpenCode setup snippets</summary>
            <p className="whitespace-pre-line text-xs text-text-muted">{clientConfig.openCodeInstructions}</p>
            <Snippet label="opencode.json" text={clientConfig.openCodeConfig} filename="opencode.json" {...snippets} />
            <Snippet label=".opencode/plugins/9router-cgw.js" text={clientConfig.openCodePlugin} filename="9router-cgw.js" {...snippets} />
          </details>
        </div>
      )}
      {selectedClient === "other" && clientConfig && (
        <div className="space-y-2 text-xs">
          <p className="break-all"><strong>API base:</strong> {clientConfig.apiBaseUrl}</p>
          <p className="break-all"><strong>Model:</strong> {clientConfig.modelId}</p>
          <p><strong>Environment:</strong> export NINE_ROUTER_API_KEY=&apos;&lt;your-key&gt;&apos;</p>
          <p className="text-text-muted">Send full conversation history each round with function calling. Local tools require outer approvals.</p>
        </div>
      )}
      <details className="space-y-2">
        <summary className="cursor-pointer text-xs font-medium">Compatibility details</summary>
        <p className="text-xs text-text-muted">Each round uses complete history with a fresh temporary turn. Sampling/output limits, structured output, and native browser extensions are unsupported. Tool approvals are controlled by your client.</p>
      </details>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">Codex native setup</summary>
        <p className="text-sm text-text-muted">Signed companion preserves local rollout lineage, sandbox/approval policy and retained tool-result rounds.</p>
        {clientConfig && (
          <div className="space-y-3">
            <Snippet label="Key generation" text={clientConfig.keygenCommand} {...snippets} />
            <Snippet label="Operator allowlist template" text={clientConfig.clientKeysConfig} filename="client-keys.example.json" {...snippets} />
            <Snippet label="Companion config" text={clientConfig.companionConfig} filename="companion.example.json" {...snippets} />
            <Snippet label="Start companion" text={clientConfig.companionCommand} {...snippets} />
            <Snippet label="Codex config.toml snippet" text={clientConfig.nativeConfig} filename="codex-9router-snippet.toml" {...snippets} />
            <Snippet label="Explicit companion interrupt" text={clientConfig.interruptCommand} {...snippets} />
            <p className="whitespace-pre-line text-xs text-text-muted">{clientConfig.nativeInstructions}</p>
            <p className="text-xs text-text-muted">Copy/download only; no automatic rewrite of config.toml or auth.json. Client tool execution is not verified here.</p>
          </div>
        )}
      </details>
    </section>
    {full && <details className="space-y-3"><summary className="cursor-pointer text-sm">Disconnect coding tools</summary><p className="text-xs text-text-muted">Stops the owned tunnel and returns this profile to browser-only. Saved configuration stays; no remote tunnel or ChatGPT app is deleted.</p><Button variant="secondary" disabled={disabled} loading={busy === "Disconnect coding tools"} onClick={disconnect}>Disconnect coding tools</Button></details>}
  </div>;
}
