# ChatGPT Web bridge (`cgw`)

`chatgpt-web` is an opt-in local bridge provider. It routes native Codex Responses requests through a separately supervised `codex-chatgpt-web` browser process on the same Linux host.

## Security contract

- 9router connects through a Unix socket under `CHATGPT_WEB_BRIDGE_SOCKET_ROOT`; it never accepts a socket path from a client and never falls back to HTTP.
- The bridge socket must be owned by the bridge user and the 9router container group. Keep the directory `0750` and socket `0660`.
- The socket exposes only `/healthz`, `/v1/web-models`, `/v1/responses`, and `/v1/responses/compact`. Admin, native Codex passthrough, browser, filesystem, search, and image routes stay off this transport.
- Discovery is web-only and does not require Codex OAuth. Unknown browser readiness is reported as `unknown`; it is never promoted to ready by a successful liveness check.
- 9router stores only the bridge ID. Do not enter cookies, ChatGPT tokens, launcher control tokens, or raw socket paths in the dashboard.

## Provisioning

1. Pin and install the bridge release separately. Run it as a non-root graphical-session user.
2. Create `/run/9router-chatgpt-web/` with group ownership shared by the bridge and 9router container. Configure the bridge socket as `<bridge-id>.sock`.
3. Resolve the numeric group before deployment: `getent group <bridge-group>` on the host, then confirm the same GID is present in the router container with `docker exec 9router-blue id`. Set that numeric value as `CHATGPT_WEB_SOCKET_GID`; never assume the bridge user's primary GID. Start both router slots with `docker-compose.prod.yml` plus `docker-compose.chatgpt-web.yml`.
4. Verify `stat -c '%A %U %G %a' /run/9router-chatgpt-web/<bridge-id>.sock` reports `0660` and the configured shared group. Add the `ChatGPT Web` connection from the dashboard, enter only the provisioned bridge ID, run `Test connection`, then save.

## Models and limits

Models are advertised only from the bridge catalog. Empty, malformed, offline, and expired catalogs do not become static fallback models. Native model IDs use the `chatgpt-web/*` namespace and are selected in 9router as `cgw/chatgpt-web/*`.

Capabilities are connection-scoped live evidence. Routing, account selection, `/v1/models`, dashboard pickers, and combo ordering use only fresh catalog fields; omitted capability fields remain unsupported, and a stale or offline connection contributes no model or capability evidence.

The browser runtime owns the maximum five active tabs and retained tool turns. Fusion and blind account/combo retries are disabled for native `cgw` requests. A disconnect after dispatch is terminal because submission status is not safely retryable.

Compact is a separate `/v1/responses/compact` operation. Luna routes reject standalone Codex compaction when the bridge contract says rolling checkpoints are authoritative.

## Deployment and recovery

The bridge/browser lifecycle is independent of 9router blue-green slots. The optional compose override mounts the same socket directory into both slots. `deploy.sh` polls `/api/health` for `active_requests` before stopping the old slot; a drain timeout leaves that slot running instead of cutting an SSE or tool turn.

If the bridge is offline, disable the connection or remove `cgw` from combos. Do not silently switch a stateful native conversation to `cx` or another provider. Start a new task after profile/login loss unless the bridge reports a valid continuation.

Generic Chat Completions, generic Claude, image generation, search, encrypted native-to-Web subagent payloads, and unverified resolved-model claims are unsupported until their separate live compatibility gates pass.
