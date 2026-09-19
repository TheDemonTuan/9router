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
