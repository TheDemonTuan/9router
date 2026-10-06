# Hướng dẫn Triển khai & Vận hành Tự động 9router (Blue/Green + Split-Domain + Traefik)

Hệ thống deploy tự động cho **9router** được thiết kế theo chuẩn Zero-Downtime, phân tách tên miền (Split-Domain) tương tự như kiến trúc của **OmniRoute**, tận dụng hạ tầng có sẵn trên VPS (**Cloudflare Tunnel** và **Traefik Edge Ingress**).

---

## 1. Kiến trúc Split-Domain & Security Matrix

```text
                                  INTERNET
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
  [Cloudflare Access BẬT]                              [Cloudflare Access TẮT]
9router-admin.tuannguyenviet.site                    9router-api.tuannguyenviet.site
(Dành cho Admin Dashboard & Settings)                (Dành cho AI clients, Cursor, Claude...)
            │                                                   │
            └─────────────────────────┬─────────────────────────┘
                                      │ Cloudflare Tunnel
                                      ▼
                            ┌──────────────────┐
                            │   edge-traefik   │
                            └─────────┬────────┘
                                      │
                         /opt/platform/edge/dynamic/9router.yml
                                      │
       ┌──────────────────────────────┴──────────────────────────────┐
       │                                                             │
       ▼                                                             ▼
[Dashboard Router]                                            [API Hardened Router]
- Cho phép Web UI, Static Chunks                              - Chặn 100% Web UI & Admin API (403)
- Cho phép Admin APIs (/api/keys, /api/settings,...)          - CHỈ cho phép /v1/*, /chat/*, /models/*
- Xác thực qua Cloudflare Access JWT/Email                    - Rate Limit qua Traefik Middleware
                                                              - Bắt buộc API Key hợp lệ tại App
```

---

## 2. GitHub production environment

`TheDemonTuan/9router` dùng environment `production`, giới hạn deployment vào nhánh mặc định `master`. Chỉ environment này giữ `DEPLOY_SSH_KEY` (key riêng cho user `deploy-9router`); public host key ED25519 được pin trong composite action của platform, không lấy từ secret. Variables: `DEPLOY_HOST`, `DEPLOY_PORT=22`, `DEPLOY_USER=deploy-9router`. Key chỉ được đọc trong job caller có `environment: production`: GitHub không truyền environment secret vào job của reusable workflow. Không dùng lại `VPS_SSH_KEY`, `VPS_USER`, `VPS_HOST`, `VPS_PORT`, `DEPLOY_PATH` từ repo cũ; xóa chúng sau operator canary và trước khi bật workflow mới.

Caller pin release của `TheDemonTuan/vps-deploy`, commit `630272ccb6c4377748e4b153d1784586ff8c6602`, đồng nhất ở `uses: ...@<SHA>`, `platform-ref` và host profile. Giữ workflows cũ disabled trong suốt adoption/canary; chỉ bật caller mới sau khi xóa credentials cũ.

`.deploy/app.yml` là manifest được operator đăng ký theo commit, không chứa host paths/secrets; khi đổi manifest cần operator review và đăng ký lại. Workflow `deploy.yml` chạy `.deploy/verify.sh`, reusable build xuất immutable digest sau `.deploy/smoke-image.sh`, rồi job deployment có environment `production` gọi composite action platform để yêu cầu engine trên host cutover. Không gửi GitHub token hoặc shell/script ứng dụng lên host.

### ChatGPT Web: CLI tools do client thực thi

Browser-only nhận standard function tools qua `/v1/chat/completions` và `/v1/responses`, cả JSON và SSE, khi exact model/account row có `generic_tools: true`. CLI dùng base URL OpenAI-compatible `/v1` và gateway API key thông thường; không cần Codex CLI, companion hoặc MCP connector. Public catalog project `tools: true` cho capability này; không cấp native `exec`/`mcp_tools`.

Client thực thi tool calls trên workspace/sandbox của client rồi resubmit toàn bộ history và matching results. Giữ nguyên call IDs; mỗi call cần đúng một result trước message mới. Chat dùng assistant `tool_calls` + role `tool`; Responses có thể replay nguyên returned `output` rồi append `function_call_output`. Hỗ trợ `auto`/`none`/`required`/named choice và `parallel_tool_calls`; chỉ function tools, không hosted/custom/native tools, opaque reasoning replay hoặc `previous_response_id`.

Tool rounds buffer private JSON decision tới browser completion, validate toàn batch/schema trước public emission; malformed decision trả `browser_tool_output_invalid`, không retry/fallback. Runtime cũ thiếu `generic_tools` trả `browser_tools_unavailable` trước Send; text-only vẫn dùng đường cũ. Chưa chứng minh compatibility của một CLI/version cụ thể nếu chưa chạy nó.

Smoke client độc lập: `bun tests/integration/chatgpt-web-client-tools-smoke.mjs --base-url <gateway>/v1 --api-key-file <private-file> --model <exact-catalog-id> --wire chat --stream true`. Endpoint ngoài loopback bắt buộc `CGW_LIVE=1` và `--live`. Driver chỉ Read/Edit/Exec trong fixture temporary riêng, bắt buộc fail-before/pass-after và final `CGW_CLIENT_TOOLS_OK`; API key không được đặt trên command line.

## 3. Cấu hình Cloudflare Tunnel (Thực hiện trên Cloudflare Zero Trust)

Truy cập Cloudflare Zero Trust -> **Networks** -> **Tunnels** (Tunnel đang kết nối tới VPS):
1. **Host Dashboard:**
   - **Public hostname:** `9router-admin.tuannguyenviet.site`
   - **Service:** `HTTP` -> `172.31.250.4:8080` (hoặc `edge-traefik:8080`)
   - **Access Policy:** Thêm Application bảo vệ bằng Cloudflare Access (Email OTP/Google SSO).
2. **Host API:**
   - **Public hostname:** `9router-api.tuannguyenviet.site`
   - **Service:** `HTTP` -> `172.31.250.4:8080` (hoặc `edge-traefik:8080`)
   - **Access Policy:** **KHÔNG BẬT** Access Policy để các client IDE/CLI gửi API Key trực tiếp.

---

## 4. Vận hành có kiểm soát

Workflow `.github/workflows/deploy-ops.yml` có ba thao tác: `status`, `rollback` (chỉ `app`), `reconcile` (`app` hoặc `rtk`). Mọi thao tác đi qua environment `production`, key restricted và forced command; không nhập tùy ý tag, slot, shell hay đường dẫn trên host. Nếu request bị ngắt SSH, kiểm tra lại status theo cùng request ID thay vì deploy lại với ID mới. `reconcile` là thao tác operator sau sự cố; không có scheduled auto-failover.

Operator trên VPS sau adoption có thể kiểm tra bằng:

```bash
sudo -n /opt/vps-deploy/current/bin/deployctl status --app 9router --strict
```

Chỉ `complete` và strict status khớp route generation/slot/digest mới chứng minh cutover; slot cũ đang drain có thể vẫn chạy sau khi request hoàn tất. Rollback chỉ dùng previous image/container còn được giữ và không đảo SQLite migration. Không sửa trực tiếp `9router.yml` sau adoption.

---

## RTK sidecar riêng

RTK là tối ưu tùy chọn: không có sidecar hoặc sidecar lỗi thì tool output giữ nguyên. Không mở port RTK công khai; chỉ app nối network `9router-rtk` nội bộ. Sau khi PR qua native smoke trên cả amd64/arm64 và merge vào `master`, chạy `rtk-sidecar.yml` bằng `workflow_dispatch`, `publish=true`, `deploy=true`. Workflow publish manifest digest bất biến rồi yêu cầu central deploy qua restricted SSH; RTK không đổi route app. Nếu chưa publish thì không deploy. App chạy Bun local không Docker: chỉ cấu hình `RTK_URL=http://127.0.0.1:8080` khi đã tự chạy sidecar. Single-app Compose dùng `docker-compose.yml` với `docker-compose.rtk-app.yml`; production Compose sidecar nằm trong profile central `TheDemonTuan/vps-deploy/apps/9router/docker-compose.rtk.yml`, không copy vào app checkout.

Classifier RTK nhận metachar literal trong dấu nháy và một prefix `cd /path &&`, `cd ./path &&`, `cd ../path &&` (có thể dùng `cd -- PATH`) trước command được hỗ trợ. Không chạy lại command; chỉ gửi output đã có đến filter. Pipe, redirect, expansion, nhiều command sinh output, tool thiếu command và output không rõ định dạng giữ nguyên. HTTP thành công không đồng nghĩa đã nén: kết quả rỗng hoặc không nhỏ hơn vẫn giữ nguyên.

Host profile giữ network sidecar tách biệt. App deploy kiểm network nội bộ trước cutover; rollback/status không phụ thuộc RTK. Trường hợp request đang `recovery_required`, không chạy legacy deployment hoặc stop container thủ công: operator kiểm state và dùng `reconcile`.

## 5. Route Generation ACK & Zero-Downtime Verification

Route Generation ACK xác nhận Traefik đã nạp route 9router; lock publisher chỉ bảo vệ các ứng dụng cùng tham gia. Deployment ACB/Messenger chưa dùng lock này, nên không khẳng định loại bỏ mọi race trên shared edge:

### Cơ chế hoạt động
1. **Generation Token:** Publisher trung tâm render `9router.yml`, sinh generation ngẫu nhiên 32 ký tự hex (`uuid.uuid4().hex`).
2. **Traefik Middleware `9router-route-generation`:**
   Cấu hình dynamic khai báo middleware:
   ```yaml
   http:
     middlewares:
       9router-route-generation:
         headers:
           customResponseHeaders:
             X-9Router-Route-Generation: "<gen>"
   ```
   Middleware này được gắn trực tiếp vào cả `9router-api-router` và `9router-dashboard-router`.
3. **Public Route Probe & Dual ACK:**
   - Mỗi lần probe public route (`/api/health`), script kiểm tra đồng thời:
     - Payload JSON chứa identity slot (`deployment_slot`: `blue` hoặc `green`).
     - Response header `X-9Router-Route-Generation` chứa token generation trùng khớp.
     - Header chống cache (`Age`, `CF-Cache-Status` không được là cache hit/stale).
   - Hàm `wait_route_slot` bắt buộc phải quan sát được **2 lần probe liên tiếp** khớp cả slot đích và generation token mới thì mới coi cutover thành công.
4. **Giám sát trạng thái:** `deployctl status --app 9router --strict` yêu cầu route trên đĩa, phản hồi public và image/slot thực khớp state; exit code khác 0 khi chưa nhất quán. Workflow ops `status` cung cấp thông tin không chứa secrets.

---

## 6. Runbook: Kiểm tra External Network Persistence (`edge-9router`) cho Container `edge-traefik`

Traefik Edge Ingress (`edge-traefik`) và các container ứng dụng 9router (`9router-blue`, `9router-green`) giao tiếp qua Docker bridge network dùng chung mang tên `edge-9router`. Nếu container `edge-traefik` bị mất kết nối vào network này, Traefik sẽ không thể phân giải hostname container và trả về lỗi `502 Bad Gateway`.

Kiểm tra read-only trước khi can thiệp vào hạ tầng dùng chung:

```bash
docker network inspect edge-9router --format '{{range .Containers}}{{println .Name}}{{end}}'
docker inspect edge-traefik --format '{{json .NetworkSettings.Networks}}'
sudo -n /opt/vps-deploy/current/bin/deployctl status --app 9router --strict
```

Kết quả mong đợi có `edge-traefik` và container slot active. Engine kiểm tra mount dynamic, network, middleware và route namespace dưới lock trước publish. Nếu mất kết nối hoặc trả `502`, dừng cutover, điều tra nguyên nhân; không tự tạo lại network hay nối shared `edge-traefik` bằng lệnh bỏ qua lỗi.

## ChatGPT Web runtime: dashboard và desktop riêng

Chỉ thao tác trên staging được operator cấp quyền; phần này không kích hoạt production deploy. Gateway phải được operator cấu hình runtime URL và hai token DATA/ADMIN riêng qua mounted files. Dashboard **không** nhận URL runtime, bearer, cookie ChatGPT hoặc mật khẩu VNC. `/api/providers/chatgpt-web/runtime/*` chỉ nhận dashboard JWT hoặc Cloudflare Access JWT đã xác minh, kể cả `requireLogin=false`; API key và CLI machine token không cấp quyền admin. Public API host vẫn chặn các route này; mutations yêu cầu cùng origin dashboard.

1. Mở provider **ChatGPT Web**, chọn **Add connection** hoặc sửa connection. Nhập **Profile ID** canonical (1–64 ký tự chữ thường/số/hyphen, đầu/cuối là chữ/số); các connection cùng ID dùng chung browser và giới hạn 5 turns.
2. Trong **Runtime profile**, chọn profile đã có hoặc bấm **Create profile**. Profile mới mặc định Browser-only, Retain, Temporary, Bigger Context/automatic approval tắt. **Start Login** chỉ dùng khi profile idle; CAPTCHA/2FA xử lý trực tiếp trên desktop riêng, không bypass.
3. Khi Start Login/View Browser cấp lease, mở tunnel trên máy operator:

   ```bash
   ssh -N -L 17842:127.0.0.1:17842 <operator-host>
   ```

   Dùng native VNC client kết nối `localhost:17842`. Operator lấy mật khẩu lease từ file owner-only trong tmpfs `/run/cgw/login/` qua SSH/container access riêng; không gửi mật khẩu qua API/chat/dashboard. Một lease tối đa 15 phút, chỉ một profile được xem cùng lúc. Không public noVNC, screenshot/DOM export, CDP hay Playwright server. **View Browser** xem desktop/tab đang có để Allow once, không restart turn đang chạy.
4. Sau login, chủ động bấm **Run browser smoke** để kiểm chứng, xem state/models/reasoning/connector diagnostics rồi **Test connection** và **Save connection**. Poll khi panel mở chỉ đọc diagnostics; không tự gửi model/tool request. Smoke có thể gửi model turn thật và chỉ chạy khi operator bấm.
5. Full yêu cầu tunnel và connector **Codex Native2** được operator provision và runtime xác minh; mode không được bật thành công khi prerequisites bị từ chối. **Run harness diagnostics** không thay thế staging E2E có companion/Codex thực thi harmless fixture ở máy người dùng; UI không tuyên bố local-tool E2E nếu chưa có observation đó.
6. Settings lưu tại sidecar bằng expected revision; khi active hoặc revision conflict, refresh và review trước khi áp dụng lại. **New each turn** chỉ đổi conversation giữa human turns, không đổi tool-result rounds. **Saved** có thể áp dụng Memory/custom instructions. Bigger Context chỉ cho routes hỗ trợ multipart, tăng latency/tổng context chứ không tăng per-message limit. Automatic approval chỉ hiển thị Full, chỉ Allow once đúng connector; outer Codex sandbox/approval policy vẫn giữ nguyên.

Đóng panel dừng polling và abort các HTTP observers của UI; lease desktop vẫn do runtime hết hạn/đóng, không tự xóa browser profile. Restart/login maintenance không được ngắt profile đang có turns. Drain/quiesce/resume thuộc lifecycle operator có operation fence matching; không sử dụng dashboard health poll hoặc `readyz=200` để thay deployment gate.

### Companion trên máy Codex và activation gate

Gateway chỉ nhận native CGW qua companion loopback có public key đã provision. Runtime giữ browser/tunnel/broker, không thực thi shell hoặc tool của Codex. Operator tạo Ed25519 keypair bằng Bun `1.4.0` trong package runtime:

```bash
bun run companion:keygen /private/cgw-client.pem /private/cgw-client.pub.pem
CGW_COMPANION_CONFIG_FILE=/private/cgw-companion.json bun run companion
```

Companion config là operator-owned JSON với `gatewayUrl` (HTTPS, trừ fixture loopback), `apiKeyFile`, `privateKeyFile`, `keyId`, `clientId`, `codexHome` và `listenPort:17840`. Provision public PEM vào gateway `CHATGPT_WEB_CLIENT_KEYS_FILE` dạng `{"version":1,"clients":[{"clientId":"trusted-client","keyId":"trusted-key","publicKeyPem":"<public PEM>","enabled":true}]}` qua kênh riêng authenticated. Không gửi private key, API key, cookies hoặc `auth.json` qua chat. Disable record để revoke request mới; companion không rewrite Codex config của người dùng.

Người dùng tự đặt trong Codex `config.toml`:

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:17840/v1"
model = "cgw/chatgpt-web/gpt-5.6-sol"
model_reasoning_effort = "high"

[features]
multi_agent = true
multi_agent_v2 = false

[agents]
max_depth = 2
```

Model/effort phải có evidence của selected profile, không lấy union catalog làm authorization. Interrupt hook gọi `bun run companion:interrupt --thread-id <native-thread-id> --turn-id <native-turn-id>` với cùng private companion config; disconnect stream chỉ detach observer, không tự replay Send hoặc cancel owner.

Offline gates dùng `services/chatgpt-web-runtime/scripts/smoke-offline.ts`, `smoke-harness-offline.ts`, `smoke-approval-offline.ts` và `tests/integration/chatgpt-web-runtime-smoke.mjs`. ChatGPT DOM và outer observer ở các smoke này là synthetic; không gọi đó là tài khoản ChatGPT/Codex live E2E. Native image gate phải chạy Linux amd64/arm64 không emulation, UID10001, sandbox/seccomp thật; thiếu Docker/host user namespaces là blocker, không thêm `--no-sandbox`.

Private staging cần ARM64 disposable host/SSH, tài khoản có model/developer-mode/write-action permission, Native2 tunnel workspace, Read+Use runtime key, compatible Codex, public key allowlist và gateway API key, tất cả qua private files. `CGW_LIVE=1 CGW_STAGING_CONFIG_FILE=/private/staging.json bun run smoke:live -- --profile <staging-profile>` chạy real Codex trong home/workspace mới, giữ sandbox workspace-write và on-request approvals. Thiếu prerequisite phải fail, không skip thành pass. Live fixture kiểm local patch/test và child/grandchild lineage; các manual compaction/multipart/progress/approval/fault/blue-green/runtime-upgrade cases trong approved matrix vẫn phải được ghi nhận riêng.

Production `.deploy/app.yml` và existing workflow pins giữ nguyên. Chỉ sau reviewed immutable platform release có component `cgw` và operator authorization mới activate manifest/registry/all caller pins cùng SHA, rồi installer check/adopt theo platform. Không publish/deploy tự động từ phiên implementation này.
