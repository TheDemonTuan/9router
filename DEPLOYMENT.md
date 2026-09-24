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

## 2. GitHub Secrets (Đã được cấu hình tự động)

| Secret Name | Giá trị |
|---|---|
| `VPS_HOST` | `134.185.89.192` |
| `VPS_USER` | `opc` |
| `VPS_SSH_KEY` | Private SSH Key (ed25519) |
| `VPS_PORT` | `22` |
| `DEPLOY_PATH` | `/opt/9router` |

---

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

## 4. Vận hành một chạm trên VPS

```bash
cd /opt/9router

# Kiểm tra trạng thái hiện tại
./deploy.sh --status

# Rollback slot cũ ngay lập tức nếu cần
./deploy.sh --rollback

# Cập nhật hoặc deploy thủ công
./deploy.sh ghcr.io/<owner>/9router:<tag>
```

---

## 5. Route Generation ACK & Zero-Downtime Verification

Để đảm bảo tính nhất quán tuyệt đối và loại bỏ hoàn toàn race condition trong quá trình cutover giữa các slot Blue/Green (đặc biệt khi Traefik file watcher reload chậm hoặc trả cache response cũ), hệ thống sử dụng cơ chế **Route Generation ACK**:

### Cơ chế hoạt động
1. **Generation Token:** Mỗi lần render cấu hình Traefik dynamic (`9router.yml`), `deploy.sh` sinh một generation token ngẫu nhiên 32 ký tự hex (`uuid.uuid4().hex`).
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
4. **Giám sát trạng thái (`--status` & `--status --strict`):**
   Lệnh `./deploy.sh --status` hiển thị chi tiết:
   - `Configured route slot` & `Configured route generation` (từ file YAML trên đĩa).
   - `Observed Traefik slot` & `Observed Traefik generation` (từ public HTTP probe trực tiếp qua Traefik).
   - Strict mode (`--status --strict`) yêu cầu cả slot và generation phải khớp hoàn toàn giữa cấu hình trên đĩa và phản hồi thực tế của Traefik mới trả về exit code 0 (`Route state: HEALTHY`).

---

## 6. Runbook: Kiểm tra External Network Persistence (`edge-9router`) cho Container `edge-traefik`

Traefik Edge Ingress (`edge-traefik`) và các container ứng dụng 9router (`9router-blue`, `9router-green`) giao tiếp qua Docker bridge network dùng chung mang tên `edge-9router`. Nếu container `edge-traefik` bị mất kết nối vào network này, Traefik sẽ không thể phân giải hostname container và trả về lỗi `502 Bad Gateway`.

### Các bước kiểm tra và xử lý sự cố mạng

#### 1. Kiểm tra mạng `edge-9router` tồn tại
```bash
docker network inspect edge-9router >/dev/null 2>&1 || docker network create edge-9router
```

#### 2. Kiểm tra container `edge-traefik` đã kết nối vào `edge-9router`
```bash
docker inspect edge-traefik --format '{{json .NetworkSettings.Networks.edge_9router}}'
```
*Kết quả mong đợi:* Trả về JSON object cấu hình IP (không phải `null`).

#### 3. Kết nối lại `edge-traefik` vào network nếu bị ngắt kết nối
```bash
docker network connect edge-9router edge-traefik 2>/dev/null || true
```

#### 4. Liệt kê toàn bộ container đang gắn vào `edge-9router`
```bash
docker network inspect edge-9router --format '{{range .Containers}}{{println .Name}}{{end}}'
```
*Kết quả mong đợi:* Phải hiển thị `edge-traefik` cùng với container slot active (`9router-blue` hoặc `9router-green`).

#### 5. Chạy preflight validation của 9router
```bash
./deploy.sh --preflight
```
*Preflight script sẽ tự động kiểm tra:*
- Container `edge-traefik` đang chạy.
- `edge-traefik` được gắn vào network `edge-9router`.
- Container slot active được gắn vào network `edge-9router`.
- File dynamic route hợp lệ, không có xung đột token `9router-route-generation` hay `9router-service` với các file cấu hình khác trong Traefik dynamic directory.
