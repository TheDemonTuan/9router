# ChatGPT Web runtime (`cgw`)

`chatgpt-web` routes browser text, OpenAI-compatible function handoff and signed native Codex requests through the separately supervised browser runtime. The gateway stores a profile selector; the runtime owns browser authentication, model evidence and physical turns. The old Unix-socket bridge transport is removed.

## Add and manage a connection

1. Open **Providers → ChatGPT Web → Add Connection**, enter a name, choose **Chrome extension** or **Private browser**, then **Continue**. Creating a connection does not submit a model prompt. Chrome creation does not start private-browser login automatically.
2. In **Connection**, follow the current next action. For Chrome, download/install the helper, keep this dashboard tab active, open the helper and confirm the displayed server/connection. Do not open it on chatgpt.com. **Check connection again** only refreshes metadata; only **Connect** collects cookies and hands a file to the authenticated dashboard.
3. **Manual import** provides paste/file alternatives. Imported credentials are bounded and cleared after submission; uncertain/consumed transfers are never replayed. Expired attempts require **Prepare connection**. Changing tabs, profiles or dirty drafts invalidates the target, not an active human-login lease.
4. For **Private browser**, sign in using the full-window workspace and choose **Finish Sign In**. This human-login Chrome process has no automation/debugging connection. The runtime closes only its owned Chrome windows to flush cookies, then verifies the same persistent profile. Incomplete verification restores the same unexpired lease. A saved connection remains if login fails: resume it rather than creating another account.

Saved connections have **Connection**, **Coding agents**, **Preferences** and **Diagnostics** tabs. Arrow/Home/End keys navigate tabs. Preference drafts survive tab changes; closing a dirty dialog offers **Discard changes** or **Keep editing**. Connection details and preference saves are separate operations. Profile selection is only a draft until saved and never resets the selected profile's existing runtime settings.

**Back to Connection** closes the viewer without ending its lease; **Open browser** resumes that exact lease. **Diagnostics → End login** ends it. Terminal leases never auto-reconnect; new leases last fifteen minutes. **Fit to Window**, **Actual Size** and **Pan** provide desktop/mobile navigation. Opening tabs, status polling and connector verification send zero prompts; an explicitly clicked model test sends a real prompt.

## Security contract

- Configure `CHATGPT_WEB_RUNTIME_URL`, `CHATGPT_WEB_RUNTIME_TOKEN_FILE` and the separate `CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE` through the operator deployment. Never enter these tokens in the dashboard.
- Mount both runtime tokens with the same operator-controlled group and mode `0640`. The gateway entrypoint keeps UID `1000` and uses the data token's group as its primary GID when dropping privileges; `su-exec` otherwise discards Docker supplementary groups. Token files remain read-only and are never copied or made world-readable.
- Profile mutations and viewer access require a verified dashboard administrator session even when ordinary dashboard login is disabled. API keys and forwarding headers cannot substitute for that session.
- Viewer upgrades require the exact same origin; remote access requires HTTPS. HTTP is limited to loopback development peers. Only the configured runtime and its owned loopback VNC listener are reachable.
- Only the authenticated, no-store session endpoint exposes the ephemeral VNC password to noVNC. Status/start/complete/close responses contain no password or operator instructions and identify human-login leases with `manualLogin`. Verification denies session credentials and revokes existing transports. The client never places credentials in WebSocket URLs or automatically transfers the clipboard.
- Runtime/browser images run non-root with read-only filesystems, bounded resources and the Chromium sandbox. The approved Chrome archive is provisioned by Docker into a read-only browser volume, not embedded in the public runtime image.
- Human sign-in fences model turns, settings, restart and canonical profile ownership through stop/probe/restore. Native Chrome runs in an owned process group; settlement also tracks uniquely marked detached helpers. Failure to settle keeps the physical fence. No `--no-sandbox`, certificate bypass or automation-detection spoofing is added.

## Models, authority and limits

Models and capabilities require current connection-scoped browser evidence. Empty, malformed, offline and expired catalogs do not become static fallback models. Native model IDs use `chatgpt-web/*` and are selected as `cgw/chatgpt-web/*`.

All lanes share at most five physical browser turns per profile. A sixth request is rejected as busy; cancellation retains its slot until physical settlement. Account/combo fallback and replay after uncertain submission are disabled.

Browser-only supports text through Chat Completions and Responses. Function handoff requires a Full profile, current `generic_tools` capability and separately generated generic compatibility evidence. Native requests always require signed companion authority from the Codex machine. Browser login or a 9Router API key cannot grant native authority. Compact is a separate native `/v1/responses/compact` operation; Luna routes reject unsupported standalone compaction.

## Set up coding tools

In **Coding agents → Set up coding tools**, complete the runtime-controlled checklist:

1. Verify the saved ChatGPT session in **Connection**.
2. Create a private tunnel and Runtime API key in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) and [API keys](https://platform.openai.com/settings/organization/api-keys). Enter the Tunnel ID and key, then save. Runtime-key Read/Use rights are separate from ChatGPT workspace/app permissions. Do not use an admin key, 9Router key or ChatGPT cookie. The pinned tunnel client rejects unsupported namespaced IDs instead of stripping their namespace.
3. **Start tunnel** before app discovery.
4. **Open private browser**. In ChatGPT's Plugins surface choose **+ → Add custom MCP server → Tunnel → Create as a plugin**, name it exactly **Codex Native2**, then install it. Authentication None applies only to this private tunnel. Older workspaces may expose Apps/Developer Mode instead; see [official MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Review read/write permissions; existing installations must refresh/review/publish actions to include `router_submit_tool_calls`.
5. **Finish browser setup**, then **Verify connector (zero-Send)** and **Enable coding tools**. Runtime verification, not the switch or app name, controls readiness. Zero-Send evidence does not prove the installed generic action or client tools have run.

The runtime stores managed secrets only in its profile-private `secrets/harness.json` (directory `0700`, file `0600`), never in the gateway database, browser storage or status responses. An omitted key on an update retains the saved key; an empty key is invalid. Configuration changes invalidate connector proof. Operator-mounted configuration wins for its exact profile and cannot be replaced from the dashboard. **Disconnect coding tools** stops owned processes and returns to browser-only while retaining saved configuration; it deletes no remote app or tunnel. Missing workspace MCP/write permission remains a blocker, not a reason to bypass consent.

## OpenAI-compatible agents

Select a verified model and reasoning effort, then download the project-scoped **OpenCode** configuration and `.opencode/plugins/9router-cgw.js`. Set `NINE_ROUTER_API_KEY` in the client environment. The provider is `9router-cgw`, its SDK is `@ai-sdk/openai-compatible`, and the model is the exact `cgw/chatgpt-web/*` catalog ID. Do not copy the runtime's private data/admin keys into this configuration.

OpenCode requires both context and output accounting fields. When the catalog has no verified output limit, `limit.output: 0` selects OpenCode's client-side accounting default; it is not a provider output limit. The opt-in plugin removes sampling/output-token controls for this provider and sets the selected effort. Other providers and tool permissions are unchanged; no global auto-approval is enabled.

Each API round sends complete history in a fresh temporary browser turn. ChatGPT submits one structured function batch through `router_submit_tool_calls`, receives a **queued, not executed** receipt and finishes the turn. The API returns standard function calls; the client approves/executes them and sends full history plus results in the next request. The gateway/runtime never executes client shell/filesystem tools. Only the first valid batch is accepted; model-generated prose is not parsed into calls.

Supported: standard function tools/results, `tool_choice` auto/none/required/exact and `parallel_tool_calls`, with schema/ID/history validation. Explicit draft-07, 2019-09 and 2020-12 schemas are validated and compiled in their declared dialect; unknown dialects and external references fail closed. Compiled validators are request-local and never coerce, add defaults or strip arguments. Unsupported sampling/output limits, structured output, `previous_response_id`, native/freeform tools and native broker authority fail explicitly. Tool-output text is context, not authority. Retain/Saved preferences apply to native turns, not this fresh-turn lane. Cancellation, expiry and profile changes revoke request-local capabilities; no persistent generic request or automatic retry is created.

Chat and Responses preserve system/developer priority and history order, including interleaved instruction messages. Exact Chat function choice is translated to the Responses function-choice shape. Required/exact choice without an accepted batch returns a structured error, never an assistant error answer or successful finish. Non-streaming settlement/transport failures preserve the no-fallback contract; an interrupted browser outcome is `submission_unknown`, not a reason to replay on another account. Detected tunnel loss revokes active generic capabilities and aborts their turns; physical browser slots remain held until settlement.

## Codex native

The **Native setup — three steps** disclosure generates client-specific snippets without rewriting `config.toml` or `auth.json`:

1. On the Codex machine, use the runtime package's `bun run companion:keygen <private-file> <public-file>`. Keep private keys and the 9Router API-key file on that client.
2. Give only the public PEM to the operator through an authenticated channel. The operator provisions `CHATGPT_WEB_CLIENT_KEYS_FILE` with `{version:1,clients:[{clientId,keyId,publicKeyPem,enabled:true}]}`. Generic agents do not require this allowlist.
3. Save the generated companion configuration using absolute client paths, then run `CGW_COMPANION_CONFIG_FILE=<absolute-config> bun run companion`. Apply the generated Codex snippet using loopback `http://127.0.0.1:17840/v1`, the verified model/effort and compatibility-v1 collaboration settings. Use `companion:interrupt` for explicit targeted interruption.

Native signed requests preserve canonical local rollout, lineage, sandbox/approval policy and retained browser tool-result rounds. The dashboard reports **Client tool execution: not verified here** until separate actual client execution evidence exists. Connector/tunnel readiness is not that evidence; live account and native deployment gates remain separate.

## Deployment, recovery and verification

The runtime/browser lifecycle is independent of gateway blue-green slots. Production release gates build and scan the immutable runtime before explicit publication/deployment; account state remains in operator-owned volumes. Never replace that state or silently repin a conversation after account/profile loss.

The **ChatGPT Web runtime gates** GitHub Actions workflow runs on pull requests, `master`, and the `feat/chatgpt-web-experience` task branch. It runs gateway regressions with Bun 1.4.2 and runtime gates with Bun 1.4.0; native AMD64 and ARM64 runners build their own image without emulation. CI builds the production gateway before running the companion/public Chat-and-Responses/OpenCode loop. The gateway smoke requires `BUILD_ID` and never falls back to a local dev build. Production and standalone Chrome consent checks have independent outcomes, so one failed smoke does not suppress the other. Safe JSON results/failures and synthetic onboarding screenshots are uploaded for seven days; credentials, private process logs and browser state are not uploaded. Live-account, image publication and deployment remain explicit protected operations, disabled for ordinary task-branch runs.

If the runtime is offline, disable the connection or remove `cgw` from combos. Do not silently switch a stateful native conversation to another provider. Start a new task after profile/login loss unless the runtime proves a valid continuation.

The native CI onboarding gate runs `tests/integration/chatgpt-web-onboarding-smoke.mjs` with isolated gateway/runtime containers and an offline website plus intercepted ChatGPT verification fixture. It proves name-only creation, distinct profiles, full-window desktop/mobile layout, exact lease resume, actual-size noVNC keyboard/pointer input, non-automated native sign-in, explicit verification, premature-verification recovery, persistent HttpOnly cookies, verified catalog readiness, terminal session rejection and owned-resource cleanup. Screenshots contain synthetic accounts only; this gate does not claim real Google/ChatGPT account compatibility. Google may reject browsers controlled by software ([supported-browser policy](https://support.google.com/accounts/answer/7675428)); separating human login removes that control channel during sign-in, but does not guarantee acceptance of a particular account or environment.
