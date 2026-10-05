# Frozen source provenance

- Repository: https://github.com/miuuyy/codex-chatgpt-web
- Revision: `fa2d2c6c24926078b46eedb2186f69f2e8d548d7`
- Release: `6.1.3`
- License: MIT; retained in `LICENSE`.
- Runtime/companion: Bun `1.4.0`. Gateway remains Bun `1.4.2`.

## Source mapping

Upstream `src/<path>` is ported at `src/<path>` without mass renaming: native Responses parser/schema/state/reasoning/compaction, bridge/SSE, model catalog and browser adapter dependencies. Dependency versions begin from the frozen upstream Bun lock. CLI setup, updater, service installer, Codex config rewriting, native OpenAI passthrough, native catalog augmentation, Electron/launcher transport and billing estimates are excluded.

Deployment security patch: override `fast-uri` to published `3.1.8` with its npm SHA-512 integrity rather than frozen `3.1.6`, addressing CVE-2026-84292/CVE-2026-84394 and the subsequent host-comparison patch. Upstream source remains frozen; dependency divergence is explicit and native tests/Trivy must pass before release.

Adapted boundaries: `config.ts`, `server.ts`, `browser-login.ts`, `process.ts`, `tunnel.ts`, `adapters/chatgpt-web/index.ts`, `browser-worker.ts`, `thread-environment.ts`, `turn-execution.ts`, `conversation-key.ts`, `compaction-handoff.ts`, and `native-compaction-control.ts`.

New remote-runtime responsibilities: `protocol.js`, `src/authority.ts`, `src/profiles.ts`, `src/runtime-state.ts`, `src/browser/manager.ts`, and `src/companion/`. The read-only `src/companion/codex-config-reader.ts` extracts upstream top-level assignment parsing; it has no config-writing API.

## Patch identities and validation boundaries

- `remote-authority`: Ed25519 provisioned client assertions, mandatory canonical local rollout resolution, explicit client path flavor, runtime data/admin bearer separation and native owner namespace. Full acceptance requires the gateway signature/replay/lineage gates; package import smoke alone is not completion.
- `persistent-browser-owner`: direct Playwright persistent context per profile/epoch, retained leases and five physical turns per profile; no remote CDP. Actual Chromium DOM/sandbox gates are required independently of package compilation.
- `idle-compaction`: synchronized monotonic real-progress renewal of the 300000ms transaction and handoff idle deadlines. Fake-clock regressions and offline actual worker smoke passed; live long-session gate remains separate.
- `duplicate-block-identity`: one-to-one ordered occurrence ledger reconciliation with range/key priority and fail-closed ambiguous alignment. Pinned failing-before/passing-after repro and true inconsistency regressions passed.
- `login-interface-proof`: wait up to 30 seconds for the unique visible composer after authenticated session identity; capability detection reuses click/primary-pointerdown activation and closes the menu in `finally`. Profile catalog verification reads validated range/locks and drives the ancestor menuitem keyboard owner with bounded, exactly-one-step readback. Authentication, native cookie handoff, ownership fencing and the upstream 6.1.3 pin remain unchanged.
- `model-header-evidence`: verbatim `readChatGptModelAnnouncements` backport from [upstream revision `b6ca2d3f91f8a2ba140b522fe3b3c50b4ebffa2d`](https://github.com/miuuyy/codex-chatgpt-web/blob/b6ca2d3f91f8a2ba140b522fe3b3c50b4ebffa2d/src/chatgpt-session.ts). Only the slider's own active menu header augments ARIA evidence; hidden/inert, multiple active headers and conflicting versions fail closed. Upstream 6.1.4 still uses Enter for capability detection; the shared activation change is a local convergence, not that upstream patch.
- `session-reuse-transfer`: typed profile-local UI/navigation failures no longer reject initialization for unrelated profiles. Safe stderr events contain only profile/stage/code/error-name/timing and catalog route/effort. Explicit admin-only verify/import share one idle maintenance lock; import is same-account-bound, bounded to 256 KiB/180 cookies, and restores the previous in-memory snapshot on mutation/probe failure. A failed restore settles the context outside maintenance and leaves it unready. No cookie values, session API bodies, messages, stacks or fingerprints enter diagnostics.

### Login verification regression gate

Run `CGW_CHROMIUM_EXECUTABLE=/path/to/chrome bun test tests/browser-login-dom.test.ts` with Bun 1.4.0. The suite uses isolated headless Chromium with sandbox enabled and fully intercepted synthetic ChatGPT/session traffic; no real credentials or prompts. It skips only when the executable variable is absent, and is included in the native image compatibility gate. Host Chrome 151.0.7922.137: 19 DOM cases passed, including delayed composer, pointer-only menu, semantic keyboard owner/catalog, header-only 5.6/6 evidence, contradictory/hidden headers, expired auth, invalid slider data and bounded typed UI failure. Focused lifecycle/viewer tests: 17 passed; runtime typecheck passed; runtime suite without the browser variable: 75 passed, 19 skipped. Gateway diagnostics use fixed allowlisted messages, retaining `profile_probe_failed`/`model_version_unavailable` without forwarding raw backend diagnostics.

The hardened `scripts/provider-onboarding-smoke.ts` requires both Sol Instant and Sol/High catalog routes, supported medium/high efforts, zero verification submissions, persistent native cookie, completed lease and rejection of the old viewer session. This task could not run the candidate-image native onboarding/UI gate: the host has no `docker` executable. Headless DOM results do not establish native cookie handoff, embedded viewer UI or resolution of the incident on a real account. No deployment or live-account access was performed.

Recovery verification on the same base revision in `fix/chatgpt-web-login-2`: Bun 1.4.0 typecheck and the full runtime suite with `CGW_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome` passed: 94 tests across 14 files, zero skips/failures, 446 assertions. Bun 1.4.2 gateway admin contracts passed 41 tests; ESLint passed the changed gateway route and admin test. Both native harness entrypoints bundled successfully. The abandoned task directory remains untouched; only the twelve owned patch files were copied into the registered recovery worktree. Docker CLI and local daemon sockets remain absent; no native image/UI acceptance is inferred from these results.

Isolated gateway `NODE_ENV=production bun run build` passed, including all 150 static pages and standalone asset copying. An initial invocation incorrectly retained `NODE_ENV=development` from dependency installation and failed prerendering `/_global-error`; correcting the invocation resolved the failure without source changes.


## Saved sessions and Chrome import

Status refreshes never verify a session or send a provider prompt. Use **Use Saved Session** to validate the existing persistent VPS profile before opening another sign-in browser. A waiting viewer lease must be completed or ended explicitly; verification/import will not close it. A UI probe failure is not proof of session expiration. ChatGPT may revoke or reject cookies even while their recorded expiry is in the future; challenges/2FA require normal sign-in, not a bypass.

Optional Chrome transfer:

1. In your personal Chrome, open `chrome://extensions`, enable Developer mode, and **Load unpacked** the repository's `tools/chatgpt-web-session-export` directory. The manifest contains a stable public key only; the extension requests only ChatGPT cookies/site access.
2. Sign in to ChatGPT in that Chrome profile, then explicitly click **Export ChatGPT Session**. The extension downloads `chatgpt-session.json`; it does not upload, watch, store or copy to clipboard. Only unpartitioned `chatgpt.com` cookies transfer, including HttpOnly/multipart cookies; no Google credentials, access-token API, localStorage or personal Chrome profile is transferred.
3. In the trusted HTTPS dashboard, choose **Add Connection & Import Session** (new account), or **Import Chrome Session** on an existing same-account connection. Select the file, then click **Import selected session**. Selection alone does not read cookies or upload. HTTP is permitted only for trusted loopback development; forwarded protocol headers cannot grant this exception.
4. Wait for actual ready/catalog proof and delete the downloaded local file. Treat the file as a credential. Account mismatch restores old cookies and never changes the existing account binding. A lost HTTP observer does not retry the upload: read the target status, then explicitly **Use Saved Session** to confirm it. On `session_restore_failed`, do not retry import; contact the operator.

Endpoints are `POST /admin/session/verify` with `{profileId, revision}` and `POST /admin/session/import` with `{profileId, revision, session}`. They require the runtime admin token; gateway dashboard authentication and same-origin checks remain mandatory. Import format is exactly `{format:"9router-chatgpt-session",version:1,cookies:[...]}`. No session file/payload is stored in the gateway database. Runtime persistent Chromium keeps cookies in the same profile directory. Missing new endpoints on an old runtime return `runtime_upgrade_required`, not a silently replayed/manual login.

### Disposable transfer proof and release gate

The actual Playwright 1.62.0 bundled Chromium extension smoke exercises `chrome.cookies` and real downloads with sandbox enabled, provider/Google networking blocked, and synthetic multipart HttpOnly/Secure cookies. It produces an exclusive `0600` synthetic session file. Branded Chrome and the pinned production browser are not substitutes for the side-loaded-extension test.

From `services/chatgpt-web-runtime`, with Bun 1.4.0 and private disposable paths:

```sh
PLAYWRIGHT_BROWSERS_PATH="$CGW_EXPORT_BROWSER_CACHE" bun x --no-install --bun playwright-core install chromium
PLAYWRIGHT_BROWSERS_PATH="$CGW_EXPORT_BROWSER_CACHE" bun scripts/session-export-smoke.ts \
  --extension-dir "$CGW_TASK_ROOT/tools/chatgpt-web-session-export" --output "$CGW_SYNTHETIC_SESSION_FILE"
CGW_CHROMIUM_EXECUTABLE=/path/to/chrome bun test tests/browser-login-dom.test.ts tests/human-login.test.ts tests/runtime-maintenance.test.ts tests/viewer-session.test.ts tests/session-import.test.ts
```

The synthetic exporter file was consumed by a disposable actual runtime HTTP/Chromium smoke: import and explicit verify reached ready with a verified Sol route and zero provider POSTs. Session-import regressions passed 13 cases/174 assertions, including full runtime reopen, account mismatch, invalid/expired schema, byte/media bounds, active/fenced targets, all clear/add/restore failure boundaries and secret-safe diagnostics. Four gateway contract suites passed 100 cases. Actual Next dashboard UI with synthetic network boundaries exercised create/import, selection-before-read, target mismatch, no replay/viewer, input clearing, and 1280×900/390×844 surfaces; these are not native container or live-account proof.
Combined runtime verification after the rollback correction: Bun 1.4.0 typecheck passed; `CGW_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome bun test ./tests` passed 112 tests across 15 files, zero failures/skips, 653 assertions. The host-Chrome runtime fixtures and bundled-Chromium exporter are separate proof surfaces.
Isolated production `bun run build` passed all 150 static pages and standalone asset copying with a separate `.next-cgw-build` output. ESLint passed the changed supported JavaScript/MJS files. Workflow YAML and ten native shell steps parsed successfully. A review-discovered closed/crashed inspection-tab rollback defect was reproduced before the fix (503 instead of preserved account-mismatch 409); after separating tab quiescence from context-cookie restoration, the focused real-Chromium regression passed eight assertions and kept the original account ready after explicit verification.



From the repository root on the authorized native Docker runner:

```sh
bun tests/integration/chatgpt-web-onboarding-smoke.mjs \
  --gateway-image "$CGW_GATEWAY_IMAGE" --runtime-image "$CGW_CHECK_IMAGE" \
  --browser-volume "$CGW_BROWSER_VOLUME" --proof-dir "$CGW_PROOF_DIR" \
  --session-file "$CGW_SYNTHETIC_SESSION_FILE"
```

The runner rejects anything but the two exporter synthetic fixture cookies before creating containers, copies the file into its own root:10001/0640 fixture mount, and never alters the source file. CI exports before onboarding on each native architecture; artifacts include synthetic screenshots/results only, never session JSON. Local native onboarding remains blocked: no Docker CLI/daemon, openbox or x11vnc. Candidate image/security/native input gates must pass before release. No production account, browser, volume or deployment was mutated.

Deploy runtime first, then gateway through the existing immutable platform lifecycle. Publication/activation requires separate operator authorization, default-branch integration, completed/expired user leases, idle drain/quiesce and operator-private backup preserving existing named data/browser volumes and secrets. Verify OCI digest/revision, not only 6.1.3/upstreamRevision. Do not infer incident resolution on the VPS account from offline proof. After authorization/integration only:

```sh
gh workflow run chatgpt-web-runtime.yml --ref master -f live_account=false -f publish=true -f deploy=true
gh workflow run deploy.yml --ref master -f skip_deploy=false
```

`deploy.yml` also activates on pushes to master: hold that gateway gate until the runtime cutover is complete. Do not enable the broader live-account/Codex harness gate for a login-only check. Confirm the original account's saved session and controlled platform restart without sending a prompt; any remaining live failure must be diagnosed from the new safe stage, not bypassed.

## Current verified package gate

Task-local Bun `1.4.0`: runtime and companion entrypoints typecheck and bundle. Actual loopback HTTP smoke exercised authenticated health, data-token rejection at admin routes, second-instance OS-lock rejection, unprobed readiness 503, signed companion interrupt with gateway credential replacement and cross-origin rejection. This smoke did not exercise Chromium, ChatGPT, outer Codex tools, deployment or production.

Release remains gated by the approved complete offline and private-account staging acceptance matrix. Missing live prerequisites must remain explicit; never infer Full readiness from endpoint availability or package compilation.

## Durable state and ownership gate

`tests/runtime-state.test.ts`: four passing cases (19 assertions) cover binding CAS/no repin, replay/model scope, durable fence/restart/continuation, account epoch invalidation and Responses client isolation. Actual HTTP smoke confirmed separate-process singleton exclusion, drain mutation fencing, foreign quiesce/resume rejection, diagnostics with closed stores and fenced startup. A fresh subprocess restored the complete completed-checkpoint source revision and rejected forged summaries, cross-client proof and changed model family.

Actual Windows Chromium `153.0.8010.12` with disposable persistent profile confirmed single-flight context ownership, five physical leased turns, sixth-turn typed busy, active epoch-change rejection, exact retained page reuse, physical settlement and idle epoch replacement. This is offline browser ownership evidence only; Linux container sandbox/native ARM64 and ChatGPT Send remain separate gates.

## Authority and offline browser transport evidence

`tests/authority.test.ts`: four passing cases (17 assertions) prove provisioned Ed25519 signatures, exact body/path binding, expiry/revoke, targeted interrupts, metadata materialization/conflict and mandatory read-only canonical rollout. Actual Next.js gateway on isolated port `21127` rejected body/model/path/purpose tampering, missing/invalid API keys despite local mode, unsigned CGW requests and file-reloaded revocation. Valid normal/compact signatures reached routing (404 with no synthetic gateway connection provisioned); combined runtime cutover E2E is still a distinct gate.

Actual private broker IPC exercised owner register/update/claim with Windows drive/case/UNC roots, cross-owner update/root-escape rejection, identical native IDs in independent clients, cross-token output rejection, original MCP waiter settlement and duplicate-output rejection. This was Windows IPC, not Linux remote-path acceptance evidence.

`scripts/smoke-offline.ts` executes actual persistent Chromium, authenticated runtime HTTP, current session probe, delayed DOM model/effort readback, persistent composer clearing, native request parser, incremental Responses stream and parallel single-use JTI admission. It observed exactly one physical Send and a completed terminal response. Unsupported effort and expired session produced no further Send; expiry invalidated readiness. Its ChatGPT origin/session/answer are explicitly synthetic browser fixtures, never live ChatGPT or outer Codex tool E2E claims.

## Streaming and compaction idle patch evidence

`duplicate-block-identity`: 21 Markdown behavior tests passed (111 assertions). `scripts/repro-markdown-duplicate.ts` verified immutable pinned source SHA256 `7db05104c357e232bf2fc76044ed13638b3e602dc0398715f397cc21b04a6e7a`; all three duplicated-paragraph scenarios failed before and passed after with stable incremental deltas and both occurrences preserved. Exact pending/range/key anchors precede one-to-one ordered semantic ledger alignment; ambiguous observations defer and remain terminal consistency errors if unresolved.

`idle-compaction`: nine deterministic behavior cases passed; combined Markdown/idle run: 30 passing tests, 140 assertions. Accepted monotonic MCP/browser/tool/checkpoint progress synchronously renews the transaction capability and local 300000ms idle deadline. Progress at four/eight/twelve minutes survives; static/repeated observations do not renew; expired/submitted/consumed/revoked capabilities cannot revive. Verbatim upstream transaction fixture under `tests/fixtures/upstream-fa2d2c6/` reproduces fixed-wall-clock capability expiry from the pinned revision. Actual offline Chromium/HTTP stream smoke passed again after integration; this does not replace live long-session staging proof.

## Native harness and deployment evidence limits

Actual offline persistent Chromium → native MCP SDK stdio → private broker → Responses namespaced function/custom freeform calls → synthetic local observer outputs → same browser final completed with two tool executions and one physical Send. A separate actual MCP stdio test proved parent/child/grandchild concurrent traffic, rejected a 10s `wait_agent`, accepted 30s, and withheld completion until tool/activity settlement. Actual approval DOM smoke proved false means no automatic click, manual Allow once continues, opt-in clicks only Allow once, unrelated connectors stay untouched and expiry is typed terminal. These are explicitly offline fixtures, not real Codex/ChatGPT/OpenAI tunnel staging.

Gateway focused contract run: 154 tests passed across 14 files; real disposable Bun SQLite migration smoke passed selector conversion, conflict deactivation, rollback, idempotency and terminal legacy pins. Production Next.js build completed under isolated state. Actual dashboard UI displayed dotted routes/efforts, account readiness/0-of-5, protected anonymous administration with 401 despite `requireLogin=false`, rejected Full without prerequisites, and saved/restored fresh/saved runtime settings. A same-origin Host/internal-Next-URL mismatch found by that UI exercise was corrected without permitting cross-origin mutation.

Before GitHub Actions verification, native Linux image/sandbox/ARM64/VNC/tunnel and complete private live staging gates were blocked locally: Docker/WSL and staging SSH were unavailable. The full platform Python suite failed on Windows due to `os.fchmod`, `O_DIRECTORY`, POSIX ownership/mode assumptions and shell behavior. Five focused recovery/snapshot/activation tests passed, but were not Docker/systemd lifecycle proof. The remote native results below supersede these local verification limits; private account gates remain unrun.

## Integrated final offline run

Final Bun `1.4.0` runtime gate: typecheck passed; 57 tests passed across 11 files, 275 assertions. Final focused gateway gate under Bun `1.4.2`/Vitest: 156 tests passed across 14 files. ESLint passed the changed authority/routing/transport/admin/modal/panel files. Final isolated production `bun run build` completed.

`bun tests/integration/chatgpt-web-runtime-smoke.mjs --runtime-url http://127.0.0.1:25841 --gateway-port 25127 --runtime-bun D:/cgw-task-tools/bun-1.4.0/bun-windows-x64/bun.exe --chromium C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe` passed using **two production custom-server gateway processes** plus two companions, read-only canonical root/child rollout fixtures, actual persistent Chromium and actual MCP SDK stdio. Evidence: dotted public reasoning catalog; missing/poisoned/forged lineage rejected; body/model/path/revoked/API-key failures blocked before Send; compact raw signature preserved; signed interrupt works after rollout removal and settles pending MCP owner; durable binding survives blue/green; duplicate DB rows share profile; identical JWS admits once; Browser-only priority candidate is skipped for tools; disabling all rows gives 409/no-fallback/no extra Send, and restoring rows resumes the same pending browser through the other gateway. Namespaced read/custom patch had exactly two synthetic local observer executions and one physical browser Send. Owned resources were cleaned.

The E2E writer's initial Next-dev child stream attempt failed without a captured terminal code; a subsequent Next-dev run and integrated production-server run passed. That initial intermittent failure is not described as root-caused. Native image invocation on Windows explicitly failed with `BLOCKED: --image requires native Linux Docker; no WSL/emulation fallback`; `CGW_LIVE=1` without private staging config explicitly failed rather than skipped. Production activation remains disallowed.

## GitHub Actions native verification (2026-10-03)

App commit `b00377d7cbae5516ae7a36020741a4198524df54` passed [ChatGPT Web runtime gates 37120799498](https://github.com/TheDemonTuan/9router/actions/runs/37120799498) on native Linux amd64 and ARM64. Both jobs passed Bun 1.4.0 typecheck, 57 runtime tests (275 assertions), entrypoint compilation with the installed Playwright package external, native image build, actual Chromium namespace and Seccomp-BPF sandbox reports, offline HTTP/MCP/approval fixtures, and production custom-server gateway/companion image E2E after a Bun 1.4.2 Next.js build. The gateway job passed 160 focused Vitest tests across 15 files and the real disposable Bun SQLite migration smoke.

The profile smoke holds five browser leases concurrently, requires the sixth to return `503 provider_busy`, then releases all leases and verifies physical idle. The earlier single-lease smoke was insufficient concurrency evidence and is superseded by this run. Failed sixth-turn assertions previously leaked leases into teardown and caused canceled runs; cleanup now releases owned leases even on failure. Child compatibility stdout/stderr is inherited for remote diagnostics; the earlier speculation that pipe buffering caused the hang was not proven.

The seccomp profile retains pinned upstream clone rules and allows `chroot` independently of the initial OCI capability set: Chromium acquires this capability inside its user namespace, while Docker's capability-conditioned allow would otherwise omit the syscall when ALL container capabilities are dropped. The final native run uses the default host AppArmor policy, with no teardown, unconfined override, sysctl change, SYS_ADMIN, or no-sandbox fallback. Unprivileged `/proc` observation reported zero renderers; sandbox proof is the actual browser's `chrome://sandbox` report plus successful DOM interaction, not privileged renderer-process enumeration. Readable renderer status assertions fail closed.

Platform commit `6dfb57053f52c38b9bcdff4c8d4ecf49f2de2ec2` with this same app SHA passed [native Docker/systemd lifecycle 37120838018](https://github.com/TheDemonTuan/vps-deploy/actions/runs/37120838018) on both architectures: full 41 Python tests, blue-green shell harness, image/browser smoke and ten persisted-phase SIGKILL/reconcile cases. The two OCI variants differ by labels only; cross-release schema migration is not claimed. Registry pushes are confined to an ephemeral loopback fixture, never GHCR.

The same platform commit passed [Platform verification 37120838027](https://github.com/TheDemonTuan/vps-deploy/actions/runs/37120838027) on both architectures: immutable migration baseline, all 41 current Python tests, blue-green shell harness, actionlint and disposable Traefik/systemd integration.

Private ChatGPT/Codex, authenticated outbound tunnel, VNC login and operator staging still require private provisioning and were not run. The live job was skipped, not passed. No default-branch merge, release publication, production deployment or production pin activation was authorized or performed. All runtime/test/build execution for this GitHub Actions phase occurred on remote runners.

## Authorized production integration and security gate (2026-10-03)

The operator subsequently authorized main-branch integration, publication and deployment. App `master` now includes current Token Saver/Codex/security work plus CGW; platform `main` and immutable tag `v1.1.0` use `f6d40a519c2bf8b0a19e3f9c714b737875052870`. Production callers pin the same release. Combined-source app Actions passed, and native platform integration/lifecycle checks passed before publication.

After removing unused root proxy dependencies and updating runtime fast-uri, [publication run 37124825739](https://github.com/TheDemonTuan/9router/actions/runs/37124825739) passed native amd64/ARM64, gateway/current production regressions, source Trivy and real compatibility-evidence image publication. The immutable image `ghcr.io/thedemontuan/9router-cgw-runtime@sha256:70cab567be2b5dc159c64929f8bebe5ae53c9522431f3401e02fa51c7be43d60` failed the unchanged HIGH/CRITICAL image gate. Its Debian 12.15 result contains 8 CRITICAL and 204 HIGH findings, 150 without FixedVersion; actual bundled tunnel-client/cloudflared binaries each have 22 HIGH findings. No ignore rule, severity reduction, sandbox bypass or production activation was applied.

The old production gateway/engine/route remain active. Selected app configuration and a read-only SQLite backup were captured before provisioning new root-owned runtime token files and an empty client-key allowlist. The three production caller workflows remain paused to prevent new-manifest requests reaching the old host engine. CGW has not been started and no real ChatGPT/Codex credentials were provisioned.

The operator authorized upgrading OS/browser/tunnel assets while retaining the security gate. Commit `fc98dcef` incorrectly added 77 vulnerability exceptions and removed SPDX evidence; a suppressed scan is not evidence of remediation. Run [37131181060](https://github.com/TheDemonTuan/9router/actions/runs/37131181060) failed native image builds because Chromium `154.0.8037.92-1~deb12u1` is absent from the pinned snapshot. No deployment occurred. The exceptions are removed; release requires unsuppressed security scans, complete dependency provenance and native browser/harness checks.

Native ARM64 patched tunnel source build: Go `1.27.1`, full-client source `a390c168ff1b2d14e73a95991c186c6aba3ff5a0`, cloudflared source `733bfb939963e150dcf5c4faddb1603f744fbc98`, readonly patched module checksum graphs. Actual binaries and both generated SPDX documents passed Trivy `0.74.0` HIGH/CRITICAL with no ignorefile; rootless offline `init` using synthetic credentials passed. Binary SHA256: tunnel-client `6ef5cef36ec2033df1f244311c3d85f2863fb51b9754f90cf46ce5bbd6b367af`, cloudflared `24f2f4bba0ea4e5e1d80ca2552e705cbc40ace115b71c0b15d402acd6b390273`. This is not proof of live tunnel connectivity or AMD64 build compatibility.

Signed Ubuntu `24.04` snapshot `20261003T000000Z` with the complete proposed desktop/browser-library closure (303 installed packages) passed an actual native ARM64 build and unsuppressed Trivy HIGH/CRITICAL scan. An initial resolver metadata check failed because inherited `docker-gzip-indexes` overrode the helper's configuration; explicitly setting `Acquire::GzipIndexes=false` on the update command fixed the real native path. The browser binary was not part of this historical closure proof. At that time, runtime cutover was blocked pending a combined browser image; the later Docker-only Chrome design below supersedes source-built Chromium.

[Native security assets run 37135395489](https://github.com/TheDemonTuan/9router/actions/runs/37135395489), source `2864d70e`, passed on both AMD64 and ARM64: signed Ubuntu closure, actual patched tunnel/cloudflared compilation, rootless offline profile initialization, and unsuppressed Trivy HIGH/CRITICAL including generated SPDX. Neither architecture contains a browser in this test; combined browser/harness image and deployment gates remain pending.

A prior native stable Chromium source-build attempt did not produce a verified browser artifact: the AMD64 hosted job hit its six-hour execution limit, and ARM64 stopped in toolchain bootstrap. The operator subsequently clarified that the goal is the ported Playwright/Chrome runtime, not maintaining a browser compiler pipeline. That source-build workflow and its toolchain scripts/lock are removed.

## Historical prebuilt browser cutover (2026-10-04)

The runtime keeps upstream `playwright-core` and the configured browser executable. Browser installation uses Debian's prebuilt Chromium `154.0.8037.92-1~deb13u1` on native AMD64 and ARM64, not a custom browser build or a pre-release fallback. The Debian 13 base is digest-pinned; packages come from the signed `20261003T000000Z` snapshot. Both security package indexes were checked and contain that exact Chromium version. Native sandbox, actual gateway/browser/MCP fixtures and unsuppressed complete-image HIGH/CRITICAL scans remain required. No combined-image success or production activation is claimed before those checks finish.

[Native prebuilt run 37187413833](https://github.com/TheDemonTuan/9router/actions/runs/37187413833), commit `cf0425b4`, built both architectures and passed runtime typecheck/57 tests, rootless sandbox DOM, browser/MCP/approval/profile fixtures, and production-mode gateway/runtime HTTP E2E. Gateway contracts passed 160 tests; preserved production regressions passed 1083 Vitest tests and the separate Bun/smoke checks. The workflow failed the unsuppressed complete-image scan: each Debian 13 image contains 91 HIGH and 1 CRITICAL OS-package findings, including libxml2 `CVE-2026-6653`. No publication, production activation, live ChatGPT, real Codex or outbound tunnel E2E was performed by this run.

The [Debian tracker for CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653) marks the current trixie libxml2 package vulnerable; the published fixed package is in unstable, not stable. Its `no-dsa (Minor issue)` disposition does not mean fixed or unaffected. A stable snapshot refresh cannot currently clear this finding. The previously verified Ubuntu closure cannot simply install Bookworm Chromium: its package dependencies include `libjpeg62-turbo` and `libdav1d6`, whereas Noble supplies different library packages/ABIs. No forced package dependencies, ABI aliases, scanner suppression or browser source-build fallback is used.

## Docker-only browser provisioning (2026-10-04)

The selected deployment is a **public, browserless runtime image plus Docker Compose browser-init service**. There is no private runtime image, host-installed Chrome/Python prerequisite, browser compiler pipeline, or host browser bind mount. The image includes Python 3 from the same signed Ubuntu 24.04 snapshot/package closure as its other runtime libraries. Google's Chrome terms apply to its downloaded payload, not this package's MIT license; no Chrome binary is included in OCI layers or uploaded CI artifacts.

The image creates an **empty** `/opt/cgw-browser`, owned by UID:GID `10001:10001`, so Docker's initial named-volume copy-up gives the non-root initializer write access. Production Compose uses cache key `cgw-browser`, named volume `9router-cgw-browser`, mounted at `/opt/cgw-browser`; `/data` remains a separate persistent state volume. Both services use the same candidate image. Browser-init runs `python3 scripts/install-browser.py --manifest image-build-manifest.json` as `10001:10001`, with read-only root, all capabilities dropped, no-new-privileges, `/tmp` and `/run` tmpfs, CPU `0.5` and memory `1g`. Runtime waits for `browser-init` with `service_completed_successfully`, mounts the cache read-only and uses CPU `1.0` and memory `2g` plus the existing reviewed seccomp/native sandbox policy. No privileged mode, SYS_ADMIN, no-sandbox flag, or host security-policy change is permitted.

The initializer infers native AMD64/ARM64 and the immutable version output directory from the image manifest; optional `--arch` and `--output` remain available for installer boundary tests. It downloads Chrome for Testing `154.0.8037.92` directly from the pinned Google URL **inside Docker**, verifies archive SHA256, executable SHA256 and native ELF architecture, rejects unsafe archive members, retains payload/license files, and atomically publishes `/opt/cgw-browser/154.0.8037.92`. It revalidates an existing version rather than replacing it and never removes older directories needed by retained-image rollback. Both manifest `browser.installRoot` and image `CGW_CHROMIUM_EXECUTABLE` point to that version; Compose must not override the image's executable pin. Browser SPDX and complete file provenance remain at `<installRoot>/browser.spdx.json` and `<installRoot>/.cgw-chrome.json` in the cache.

Startup rejects missing/mismatched Chrome, while native image smoke verifies all payload hashes, actual browser version and physical sandbox before browser/MCP/approval/gateway fixtures. Runtime image Trivy HIGH/CRITICAL remains unsuppressed. The central platform `scripts/scan-browser.py` uses checksum-pinned Grype `0.120.0`, no ignores, and a known-vulnerable Chrome CPE coverage probe on every `browser-vulnerabilities` scan. CI reads only SPDX **metadata through Docker** into the scanner; browser files never land on the host. Trivy's unsupported generic Chrome SPDX/filesystem scan is not browser security evidence. The redundant task-specific security-assets and Chromium resource-probe workflows are removed; full native runtime gates own this evidence. New Docker-init/native CI and publication evidence are required before claiming this cutover verified.

Provision a native offline fixture using the already built public candidate image (no host Python/Chrome):

```sh
docker volume create 9router-cgw-browser
docker run --rm --user 10001:10001 --read-only --cpus 0.5 --memory 1g \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs /run:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700 \
  --mount type=volume,src=9router-cgw-browser,dst=/opt/cgw-browser \
  cgw-runtime:check python3 scripts/install-browser.py --manifest image-build-manifest.json
bun tests/integration/chatgpt-web-runtime-smoke.mjs --image cgw-runtime:check --browser-volume 9router-cgw-browser --gateway-port 21127
```

CI uses a unique run/attempt/architecture-specific cache and removes only its own containers and volume. The gateway smoke consumes but does not delete the provided browser volume. Its workstation-local companion/browser test mode remains available for offline development; that mode is not a VPS provisioning procedure.

App run [37191670576](https://github.com/TheDemonTuan/9router/actions/runs/37191670576), source `0bffac7a`, passed native AMD64/ARM64 physical sandbox, browser/MCP and production-mode gateway HTTP fixtures. Its Trivy browser vulnerability calls were empty, so those calls do not establish Chrome coverage. Platform lifecycle run [37192094922](https://github.com/TheDemonTuan/vps-deploy/actions/runs/37192094922), source `209773ed`, passed the actual native lifecycle crash/reconcile matrix on both architectures with this private Chrome app revision. The corrected CPE scanner was exercised against Chrome `115.0.5790.171` (1866 HIGH/CRITICAL matches, rejected) and `154.0.8037.92` (zero HIGH/CRITICAL, one MEDIUM match, admitted); corrected native CI and publication remain required.
