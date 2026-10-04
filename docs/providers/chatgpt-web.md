# ChatGPT Web runtime (`cgw`)

`chatgpt-web` routes native Responses requests through the separately supervised Docker browser runtime. The gateway stores a profile selector; the runtime owns browser authentication, profile state, model evidence and retained turns. The old Unix-socket bridge transport is removed.

## Add a connection

1. Open **Providers → ChatGPT Web → Add Connection** and enter a connection name.
2. Select **Add Connection and Sign In**. The gateway provisions a distinct `cgw-<UUID>` runtime profile, saves the connection as `login_required`, and opens the private browser inside the same dialog.
3. Sign in to ChatGPT in the embedded browser. Keyboard and pointer input use the authenticated same-origin WebSocket; no SSH, external VNC client, pasted browser cookie or manual viewer password is required.
4. The runtime verifies authentication and available model/reasoning routes before reporting readiness. A saved connection remains visible if login startup fails; use **Start Login** after resolving the runtime error rather than creating another account.

**Close viewer** disconnects the displayed browser without ending its lease. **View Browser** resumes the exact active same-profile lease. **End Login** revokes credentials and transports and settles the owned VNC process. Completed, expired, closed and error leases do not automatically reconnect. A new lease expires after fifteen minutes.

**Advanced: choose an existing profile** changes only the connection draft until saved. Existing profile settings, revision and browser epoch are preserved; changing a selector resets the connection to `login_required`. Runtime failures do not partially save the selector change.

## Security contract

- Configure `CHATGPT_WEB_RUNTIME_URL`, `CHATGPT_WEB_RUNTIME_TOKEN_FILE` and the separate `CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE` through the operator deployment. Never enter these tokens in the dashboard.
- Mount both runtime tokens with the same operator-controlled group and mode `0640`. The gateway entrypoint keeps UID `1000` and uses the data token's group as its primary GID when dropping privileges; `su-exec` otherwise discards Docker supplementary groups. Token files remain read-only and are never copied or made world-readable.
- Profile mutations and viewer access require a verified dashboard administrator session even when ordinary dashboard login is disabled. API keys and forwarding headers cannot substitute for that session.
- Viewer upgrades require the exact same origin; remote access requires HTTPS. HTTP is limited to loopback development peers. Only the configured runtime and its owned loopback VNC listener are reachable.
- Only the authenticated, no-store session endpoint exposes the ephemeral VNC password to noVNC. Status/start/close responses contain no password or operator instructions. The client never places credentials in WebSocket URLs or automatically transfers the clipboard.
- Runtime/browser images run non-root with read-only filesystems, bounded resources and the Chromium sandbox. The approved Chrome archive is provisioned by Docker into a read-only browser volume, not embedded in the public runtime image.

## Models, authority and limits

Models and capabilities require current connection-scoped browser evidence. Empty, malformed, offline and expired catalogs do not become static fallback models. Native model IDs use `chatgpt-web/*` and are selected as `cgw/chatgpt-web/*`.

The browser runtime owns at most five active browser turns per profile and retained tool turns. Fusion and blind account/combo retries are disabled for native `cgw` requests. A disconnect after dispatch is terminal because submission status cannot be safely retried.

Native requests require provisioned signed companion authority from the Codex machine. Full MCP/tool capabilities additionally require verified build evidence and the provisioned Native2 connector/tunnel; browser login alone does not enable Full mode. Compact is a separate `/v1/responses/compact` operation; Luna routes reject unsupported standalone compaction.

## Deployment, recovery and verification

The runtime/browser lifecycle is independent of gateway blue-green slots. Production release gates build and scan the immutable runtime before explicit publication/deployment; account state remains in operator-owned volumes. Never replace that state or silently repin a conversation after account/profile loss.

If the runtime is offline, disable the connection or remove `cgw` from combos. Do not silently switch a stateful native conversation to another provider. Start a new task after profile/login loss unless the runtime proves a valid continuation.

The native CI onboarding gate runs `tests/integration/chatgpt-web-onboarding-smoke.mjs` with isolated gateway/runtime containers and an offline intercepted ChatGPT fixture. It proves name-only creation, distinct profiles, exact lease resume, actual noVNC keyboard/pointer forwarding, verified catalog readiness, terminal session rejection and owned-resource cleanup. Its screenshots contain synthetic accounts only; this gate does not claim real ChatGPT account compatibility.
