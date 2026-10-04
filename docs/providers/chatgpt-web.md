# ChatGPT Web runtime (`cgw`)

`chatgpt-web` routes native Responses requests through the separately supervised Docker browser runtime. The gateway stores a profile selector; the runtime owns browser authentication, profile state, model evidence and retained turns. The old Unix-socket bridge transport is removed.

## Add a connection

1. Open **Providers → ChatGPT Web → Add Connection** and enter a connection name.
2. Select **Add Connection and Sign In**. The gateway provisions a distinct `cgw-<UUID>` runtime profile, saves the connection as `login_required`, and opens a full-window private browser workspace. Runtime details and settings stay in the collapsed **Advanced** section.
3. Sign in to ChatGPT in the private browser. This human-login Chrome process has no automation/debugging connection; keyboard and pointer input use the authenticated same-origin WebSocket. No SSH, external VNC client, pasted browser cookie or manual viewer password is required. **Actual Size** shows readable native-size text; **Fit to Window** fits the desktop, and **Pan** helps navigate on touch screens.
4. Choose **Finish Sign In**. The runtime disconnects viewer transports, gracefully stops the human browser, then verifies authentication and available model/reasoning routes using the same persistent profile. An incomplete sign-in restores the human browser under the same lease before reporting failure; expiry or revocation cannot restore a terminated lease. A saved connection remains visible if startup fails; use **Sign In** after resolving the error rather than creating another account.

**Back to Connection** disconnects the displayed browser without ending its lease. **Open Browser** resumes the exact active same-profile lease, including after closing and reopening the connection dialog. **End Login** in **Advanced** revokes credentials and transports and settles the owned Chrome/VNC processes. Completed, expired, closed and error leases do not automatically reconnect. A new lease expires after fifteen minutes. Status reads never automatically probe or complete human sign-in.

**Advanced → Existing profiles** changes only the connection draft until saved. Existing profile settings, revision and browser epoch are preserved; changing a selector resets the connection to `login_required`. Runtime failures do not partially save the selector change.

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

The browser runtime owns at most five active browser turns per profile and retained tool turns. Fusion and blind account/combo retries are disabled for native `cgw` requests. A disconnect after dispatch is terminal because submission status cannot be safely retried.

Native requests require provisioned signed companion authority from the Codex machine. Full MCP/tool capabilities additionally require verified build evidence and the provisioned Native2 connector/tunnel; browser login alone does not enable Full mode. Compact is a separate `/v1/responses/compact` operation; Luna routes reject unsupported standalone compaction.

## Deployment, recovery and verification

The runtime/browser lifecycle is independent of gateway blue-green slots. Production release gates build and scan the immutable runtime before explicit publication/deployment; account state remains in operator-owned volumes. Never replace that state or silently repin a conversation after account/profile loss.

If the runtime is offline, disable the connection or remove `cgw` from combos. Do not silently switch a stateful native conversation to another provider. Start a new task after profile/login loss unless the runtime proves a valid continuation.

The native CI onboarding gate runs `tests/integration/chatgpt-web-onboarding-smoke.mjs` with isolated gateway/runtime containers and an offline website plus intercepted ChatGPT verification fixture. It proves name-only creation, distinct profiles, full-window desktop/mobile layout, exact lease resume, actual-size noVNC keyboard/pointer input, non-automated native sign-in, explicit verification, premature-verification recovery, persistent HttpOnly cookies, verified catalog readiness, terminal session rejection and owned-resource cleanup. Screenshots contain synthetic accounts only; this gate does not claim real Google/ChatGPT account compatibility. Google may reject browsers controlled by software ([supported-browser policy](https://support.google.com/accounts/answer/7675428)); separating human login removes that control channel during sign-in, but does not guarantee acceptance of a particular account or environment.
