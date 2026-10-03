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

The old production gateway/engine/route remain active. Selected app configuration and a read-only SQLite backup were captured before provisioning new root-owned runtime token files and an empty client-key allowlist. The three production caller workflows remain paused to prevent new-manifest requests reaching the old host engine. CGW has not been started and no real ChatGPT/Codex credentials were provisioned. Completing deployment requires an explicitly reviewed change to the approved Debian 12/browser/tunnel asset baseline, followed by image security and native gates; frozen vulnerable assets are not deployable under the current policy.
