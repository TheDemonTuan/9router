"use client";

import Button from "./Button";
import Input from "./Input";
import Select from "./Select";

function Snippet({ label, text, filename, copy, download }) {
  if (!text) return null;
  return <div className="space-y-2"><h4 className="text-sm font-medium">{label}</h4><pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs"><code>{text}</code></pre><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => copy(text)}>Copy</Button>{filename && <Button size="sm" variant="secondary" onClick={() => download(filename, text)}>Download {filename}</Button>}</div></div>;
}
export default function ChatGPTWebAgentTab({ profile, harness, disabled, busy, tunnelId, runtimeApiKey, onTunnelIdChange, onKeyChange, saveConfig, discardConfig, startTunnel, verifyConnector, activate, disconnect, openBrowser, waiting, endBrowser, setupOpen, openSetup, models, modelId, selectModel, effort, selectEffort, clientConfig, configError, copy, download, snippetNotice }) {
  const sessionReady = profile?.state === "ready" && profile.models.length > 0;
  const full = profile?.settings.mode === "full";
  const operator = harness?.source === "operator";
  const step = !sessionReady ? 1 : !harness?.keyConfigured ? 2 : harness.tunnelState !== "ready" ? 3 : harness.connectorState !== "verified" ? 4 : !full ? 5 : 6;
  const currentModel = models.find(model => model.id === modelId);
  const snippets = { copy, download };
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
    <div className="grid gap-4 md:grid-cols-2">
      <section className="min-w-0 space-y-3 rounded-lg border border-border p-4"><h3 className="font-medium">OpenAI-compatible agents</h3><p className="text-xs text-amber-500">Generic function handoff: {full && currentModel?.capabilities?.generic_tools === true ? "runtime ready" : "not verified / unavailable"}. Client tool execution: not verified here.</p><p className="text-sm text-text-muted">Standard function calls are handed back to your client for approval and execution. 9Router does not run shell or filesystem tools. No signed Codex companion required.</p><p className="text-xs text-text-muted">Each round uses complete history and a fresh temporary turn. Sampling/output limits, structured output, previous_response_id, native/freeform tools and native browser extensions are not supported. Local tools are not auto-approved.</p>{clientConfig && <><p className="break-all text-xs">API base: {clientConfig.apiBaseUrl}<br />Model: {clientConfig.modelId}<br />API key: NINE_ROUTER_API_KEY environment variable</p><details className="space-y-3"><summary className="cursor-pointer text-sm">OpenCode setup — copy or download</summary><Snippet label="opencode.json" text={clientConfig.openCodeConfig} filename="opencode.json" {...snippets} /><p className="text-xs text-text-muted">Install the opt-in plugin at .opencode/plugins/9router-cgw.js. It only affects provider 9router-cgw, removes unsupported client tuning and sends the selected reasoning effort. It does not change global permissions.</p><Snippet label=".opencode/plugins/9router-cgw.js" text={clientConfig.openCodePlugin} filename="9router-cgw.js" {...snippets} /></details></>}</section>
      <section className="min-w-0 space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-medium">Codex native</h3>
        <p className="text-sm text-text-muted">Signed companion preserves local rollout lineage, sandbox/approval policy and retained tool-result rounds. Connector: {profile?.connectorReady ? "verified" : "not verified"}.</p>
        <p className="text-xs text-amber-500">Client tool execution: not verified here.</p>
        {clientConfig && <details className="space-y-3">
          <summary className="cursor-pointer text-sm">Native setup — three steps</summary>
          <p className="text-sm font-medium">1. Generate client keys from the runtime package on the Codex machine.</p>
          <Snippet label="Key generation" text={clientConfig.keygenCommand} {...snippets} />
          <p className="text-xs text-text-muted">Keep private keys and API key files on the client. Never upload the private key to the dashboard.</p>
          <p className="text-sm font-medium">2. Ask the operator to provision your public PEM through an authenticated channel.</p>
          <p className="text-xs text-text-muted">Operator-only CHATGPT_WEB_CLIENT_KEYS_FILE. Replace the public PEM placeholder with the generated public key. Generic agents do not need this step.</p>
          <Snippet label="Operator allowlist template" text={clientConfig.clientKeysConfig} filename="client-keys.example.json" {...snippets} />
          <p className="text-sm font-medium">3. Start the companion and apply the explicit Codex snippet.</p>
          <Snippet label="Companion config (absolute client paths)" text={clientConfig.companionConfig} filename="companion.example.json" {...snippets} />
          <Snippet label="Start companion" text={clientConfig.companionCommand} {...snippets} />
          <Snippet label="Codex config.toml snippet" text={clientConfig.nativeConfig} filename="codex-9router-snippet.toml" {...snippets} />
          <Snippet label="Explicit companion interrupt" text={clientConfig.interruptCommand} {...snippets} />
          <p className="text-xs text-text-muted">Copy/download only; no automatic rewrite of config.toml or auth.json. Native image and browser support remain separate from generic tools.</p>
        </details>}
      </section>
    </div>
    {full && <details className="space-y-3"><summary className="cursor-pointer text-sm">Disconnect coding tools</summary><p className="text-xs text-text-muted">Stops the owned tunnel and returns this profile to browser-only. Saved configuration stays; no remote tunnel or ChatGPT app is deleted.</p><Button variant="secondary" disabled={disabled} loading={busy === "Disconnect coding tools"} onClick={disconnect}>Disconnect coding tools</Button></details>}
  </div>;
}
