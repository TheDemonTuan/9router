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

Caller pin release của `TheDemonTuan/vps-deploy`, commit `3703d57b4e4c666152a1ce9eaee2f7e0c4a7fa46`, đồng nhất ở `uses: ...@<SHA>`, `platform-ref` và host profile. Giữ workflows cũ disabled trong suốt adoption/canary; chỉ bật caller mới sau khi xóa credentials cũ.

`.deploy/app.yml` là manifest được operator đăng ký theo commit, không chứa host paths/secrets; khi đổi manifest cần operator review và đăng ký lại. Workflow `deploy.yml` chạy `.deploy/verify.sh`, reusable build xuất immutable digest sau `.deploy/smoke-image.sh`, rồi job deployment có environment `production` gọi composite action platform để yêu cầu engine trên host cutover. Không gửi GitHub token hoặc shell/script ứng dụng lên host.

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
