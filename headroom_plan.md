# Kế hoạch Triển khai Headroom 0.38.0 Gateway cho 9Router (Bản Hiệu chỉnh & Phê duyệt Cuối)

Tài liệu này xác định kiến trúc, tiêu chuẩn kỹ thuật, kế hoạch kiểm thử và lộ trình triển khai Headroom cho `TheDemonTuan/9router`, đối chiếu và khắc phục toàn bộ các sai lệch của bản kế hoạch sơ bộ tại root worktree, đồng thời giải quyết triệt để 11 vấn đề phản biện dựa trên bằng chứng mã nguồn thực tế (source evidence), căn cứ theo release chính thức **Headroom 0.38.0 (commit `94206e265203acfd72a3b939e9a964e29175ad50`, Apache 2.0 License)** và mã nguồn hiện tại của 9Router (`bf8a3ae20c61dfa00f9cd0b38d69dd4b254751e0`).

---

## 1. Nguồn Upstream, Bản quyền & Đối chiếu Mã Nguồn (Source Evidence)

### 1.1. Nguồn Upstream & Bản quyền
- **Mã nguồn tham chiếu**: [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) tại release tag `v0.38.0` (commit `94206e265203acfd72a3b939e9a964e29175ad50`).
- **Giấy phép**: Apache License 2.0. Mọi test suite, fixture hoặc contract types được chuyển ngữ/port từ Headroom sang 9Router phải giữ nguyên ghi chú bản quyền Apache 2.0.
- **Tập tin then chốt đã thẩm tra trong 0.38.0**:
  - `headroom/proxy/gateway_responses.py`: Native compressor view cho OpenAI Responses API (`input[]`).
  - `headroom/proxy/gateway_claude.py`: Native handler cho Claude Messages API.
  - `headroom/proxy/gateway_openai.py`: Native handler cho OpenAI Chat Completions API.
  - `tests/gateway/test_responses_shape.py`: Test suite đảm bảo bảo toàn cấu trúc Responses items, `encrypted_content`, tool call/output pairing và JSON arguments.

### 1.2. Danh mục Khắc phục Phản biện Dựa trên Bằng chứng Mã nguồn Thực tế

1. **Sửa Pure Stage Selector cho Antigravity (Evidence: `open-sse/providers/registry/antigravity.js:23`)**:
   - *Bằng chứng*: Định nghĩa registry của Antigravity khai báo `transport.format: "antigravity"` (Google `v1internal:streamGenerateContent contents[]`), không phải Claude native format.
   - *Khắc phục*: Cấm gán `TARGET_NATIVE` cho Antigravity vì việc nén sau translate sẽ gửi cấu trúc Google `contents[]` sang Headroom Gateway gây lỗi. Sửa thành:
     - Nếu client là Claude format: chọn `SOURCE_NATIVE` (nén Claude source format trước khi gọi `translateRequest` sang antigravity format).
     - Nếu client là Codex Responses format: chọn `SOURCE_NATIVE` (nén Responses source format trước khi gọi `translateRequest` sang antigravity format).
     - Nếu client là định dạng không native (Gemini/antigravity): chọn `BYPASS`.
2. **Khắc phục Lỗ hổng Bảo mật Quản lý Host (`src/dashboardGuard.js:73-89` vs `src/app/api/headroom/extras/route.js`)**:
   - *Bằng chứng*: `LOCAL_ONLY_PATHS` trong `src/dashboardGuard.js` chỉ có `/api/headroom/start` và `/api/headroom/stop`, thiếu `/api/headroom/restart` và `/api/headroom/extras`. Khi `requireLogin = false`, client từ xa có thể gửi POST tới `/api/headroom/extras` để kích hoạt lệnh `pip install` trên host hoặc khởi động lại tiến trình.
   - *Khắc phục*: Bổ sung ngay `/api/headroom/restart` và `/api/headroom/extras` vào danh sách `LOCAL_ONLY_PATHS`.
3. **Loại bỏ `/dashboard` và `/transformations/feed` khỏi Remote Proxy Allowlist (Evidence: `src/app/api/headroom/proxy/[...path]/route.js:81-90`)**:
   - *Bằng chứng*: Tuyến proxy hiện hữu có đoạn xử lý rewrite HTML cho path `dashboard` và chấp nhận các path streaming feed. Cho phép tải raw HTML/feed từ xa tiềm ẩn nguy cơ XSS/script injection và rò rỉ dữ liệu nhạy cảm.
   - *Khắc phục*: Triệt để loại bỏ `/dashboard` và `/transformations/feed` khỏi remote allowlist. Remote proxy chỉ chấp nhận các endpoint dữ liệu JSON đã sanitized: `/health`, `/readyz`, `/stats`, `/stats-history`. Raw HTML và raw feed chỉ được phép truy cập cục bộ (loopback only).
4. **Deep Clone Body Ngăn ngừa Nén lặp khi Fallback (`src/sse/handlers/chat.js:511-512` vs `open-sse/handlers/chatCore.js:179,353`)**:
   - *Bằng chứng*: `src/sse/handlers/chat.js:512` chỉ thực hiện shallow clone `{ ...body, model: ... }`. Khi attempt 1 thực hiện nén in-place (ở `SOURCE_NATIVE` hoặc passthrough), nếu gặp lỗi (như 429 quota, network timeout) và kích hoạt account rotation hoặc provider fallback, attempt 2 sẽ tái sử dụng body đã bị nén/biến đổi.
   - *Khắc phục*: Áp dụng `structuredClone(body)` trong `chat.js` trước mỗi attempt gọi `handleChatCore` và trước khi thực thi mutation trong `chatCore.js`, bảo đảm mỗi attempt luôn xuất phát từ payload gốc sạch sẽ.
5. **Đồng bộ Header Alias & Kill-switch PXPIPE (`open-sse/config/runtimeConfig.js:72` & `open-sse/handlers/chatCore.js:382`)**:
   - *Bằng chứng*: `TOKEN_SAVER_HEADER` hiện chỉ khai báo `x-9router-token-saver` (thiếu `x-9r-token-saver`), và `pxpipeEnabled` tại `chatCore.js:382` chỉ kiểm tra cờ cấu hình mà không kiểm tra `tokenSaverEnabled`, khiến header `x-9r-token-saver: off` không ngắt được PXPIPE.
   - *Khắc phục*: Hỗ trợ cả hai alias `x-9router-token-saver` và `x-9r-token-saver`; bổ sung điều kiện `tokenSaverEnabled && pxpipeEnabled` để kill-switch ngắt toàn bộ pipeline nén (RTK, Headroom, Caveman, Ponytail, PXPIPE).
6. **Hợp đồng Chuyển tiếp Provider Request Headers từ Gateway v2**:
   - *Bằng chứng*: Headroom 0.38.0 Gateway trả về `data.headers` là các provider request headers (ví dụ `anthropic-version`, `x-anthropic-beta`), không phải client response headers.
   - *Khắc phục*: Thiết lập hợp đồng rõ ràng: `headroomGateway.js` bóc tách `data.headers` và chuyển về `chatCore.js`. `chatCore.js` hợp nhất các headers này vào tham số `customHeaders` khi gọi `executor.execute({ ..., customHeaders: forwardedProviderHeaders })` để executor gửi lên upstream provider; tuyệt đối không đưa các headers này ra client HTTP response.
7. **Xử lý Biên Ngân sách Thời gian (Budget Exhaustion)**:
   - *Bằng chứng*: Khi `remainingPreResponseTime <= HEADROOM_RESERVE_TIMEOUT_MS` (1500ms), ngân sách `budget <= 0ms`. Nếu tiếp tục khởi tạo `AbortSignal.timeout(0)` sẽ gây abort lỗi không cần thiết.
   - *Khắc phục*: Bổ sung kiểm tra: nếu `budget <= 0`, lập tức thoát sớm (bypass) với chẩn đoán `reason: "budget_exhausted"` mà không gọi `fetch` hay tạo timer.
8. **Ghim Cứng Phiên bản Pip Install Cục bộ (`src/lib/headroom/process.js:184`)**:
   - *Bằng chứng*: `installHeadroomExtras` gọi `pip install --upgrade headroom-ai[...]` với phiên bản floating unpinned, vi phạm nguyên tắc ổn định sản xuất.
   - *Khắc phục*: Loại bỏ cờ `--upgrade`, ghim cứng phiên bản chính xác: `headroom-ai[${extrasList}]==0.38.0`.
9. **Hiện đại hóa Test Suite theo Gateway v2 (`tests/unit/headroom-responses-format.test.js:51` & `tests/unit/headroom.test.js:21`)**:
   - *Bằng chứng*: Các bài test hiện hữu đang mock response kiểu cũ (`{ messages: [...] }`) và assert kỳ vọng skip đối với Responses có reasoning/tool calls theo hàm cũ `hasUnsafeResponsesInputForCompression`.
   - *Khắc phục*: Cập nhật toàn bộ fixtures và mocks sang chuẩn Gateway v2 (`{ data: { body, turn_id, obligations, headers } }`). Chuyển các test case từ "kỳ vọng skip" sang "kỳ vọng nén thành công và bảo toàn 100% reasoning/tools".
10. **Loại bỏ Heuristic Phán đoán Billing 5% (`open-sse/rtk/headroom.js:363` & `open-sse/handlers/chatCore.js:358-360`)**:
    - *Bằng chứng*: `isHeadroomPhantomSavings` so sánh tỷ lệ giảm byte JSON < 5% để cảnh báo "provider may bill near-original payload", suy diễn billing sai lệch từ heuristic kích thước văn bản.
    - *Khắc phục*: Xóa bỏ hoàn toàn `isHeadroomPhantomSavings` và warning log tương ứng. Tách biệt rạch ròi việc log `byte_delta` thực tế (`bodyBytes: before -> after`) và các chỉ số token do Headroom báo cáo (`tokens_before`, `tokens_after`, `tokens_saved`).
11. **Chuẩn hóa Triển khai Docker Production (`docker-compose.prod.yml:3,14`)**:
    - *Bằng chứng*: `docker-compose.prod.yml` vẫn dùng repo deprecated `ghcr.io/chopratejas/headroom:latest`, RAM giới hạn 512M (nguy cơ OOM khi nén AST/payload lớn), thiếu các env vars tối ưu của 0.38.0.
    - *Khắc phục*:
      - Đổi image sang `ghcr.io/headroomlabs-ai/headroom:0.38.0` kèm digest SHA256 đã xác minh.
      - Nâng giới hạn RAM lên tối thiểu 1024M.
      - Bổ sung biến môi trường: `HEADROOM_COMPRESS_ALLOW_REMOTE=1`, `HEADROOM_SKIP_UPSTREAM_CHECK=1`, `HEADROOM_DISABLE_KOMPRESS=1`, `HEADROOM_DISABLE_KOMPRESS_FALLBACK=1`, `HEADROOM_TOOL_SEARCH=0`, `HEADROOM_OUTPUT_SHAPER=0`, `HEADROOM_MODEL_ROUTER_ENABLED=0`.
      - Đồng bộ secret token `HEADROOM_PROXY_TOKEN` giữa sidecar và các container 9router-blue/green.
      - Chuyển probe sang `/readyz`.

---

## 2. Lộ trình Phân kỳ Triển khai (Phase Breakdown)

### Phase P0: Chuẩn bị Nền tảng, Cấu hình & Docker Hardening
- **Mục tiêu**: Thiết lập cấu hình an toàn, ghim dependencies, chuẩn hóa Docker Compose và probe kiểm tra tính sẵn sàng.
- **Tập tin tác động**:
  - `open-sse/config/runtimeConfig.js`:
    - Định nghĩa `TOKEN_SAVER_HEADERS = ["x-9router-token-saver", "x-9r-token-saver"]`.
    - Thêm `HEADROOM_DEFAULT_TIMEOUT_MS = 1000`.
    - Thêm `HEADROOM_RESERVE_TIMEOUT_MS = 1500`.
    - Thêm `HEADROOM_MAX_PAYLOAD_BYTES = 20971520` (20MB).
  - `docker-compose.yml`, `docker-compose.prod.yml`:
    - Image: `ghcr.io/headroomlabs-ai/headroom:0.38.0`.
    - Xóa port mapping 8787 trên host ở production (`expose: 8787` nội bộ).
    - Cấu hình RAM limit 1024M.
    - Cấu hình env vars chuẩn hóa và token sidecar nội bộ.
  - `src/lib/headroom/detect.js`:
    - Phân tách probe sidecar version (qua HTTP `/readyz` / `/health`) và probe local pip version.
    - Cache kết quả probe (synthetic cached status) với TTL ngắn để tránh spam sidecar.
  - `src/lib/headroom/process.js`:
    - Sửa `installHeadroomExtras`: ghim cứng `headroom-ai[${extrasList}]==0.38.0`, bỏ `--upgrade`.
    - Thêm kiểm tra process command-line ownership trước khi kill PID (tránh PID recycling).
- **Trạng thái**: `[Pending Implementation]`

### Phase P1: Native Gateway v2 Core, Pure Stage Selector & Invariants Guard
- **Mục tiêu**: Triển khai Gateway v2 client, Pure Stage Selector, Deep Clone và bộ bảo vệ tính toàn vẹn của body.
- **Tập tin tác động**:
  - `open-sse/rtk/headroomGateway.js` (Mới):
    - Client giao tiếp `POST /v1/compress` chuẩn 0.38.0 (`can_redrive: false`, `can_relay_response: false`, `session_affinity: false`).
    - Tính toán ngân sách deadline: `budget = Math.min(cfg, remaining - 1500)`. Nếu `budget <= 0` -> bypass với `reason: "budget_exhausted"`.
    - Kết nối `AbortSignal` hợp nhất: client abort + preResponse deadline + local timeout. Dọn listener sạch sau khi xong.
    - Trích xuất `data.body`, `data.turn_id`, `data.obligations`, và `data.headers` (provider request headers).
  - `open-sse/rtk/headroomStage.js` (Mới):
    - Phân loại pure stage:
      - `TARGET_NATIVE`: Target thuộc `{ openai, openai-responses, claude }` -> thực thi sau `translateRequest`.
      - `SOURCE_NATIVE`: Target không native (vd: `antigravity`, `gemini`), nhưng Source thuộc `{ openai, openai-responses, claude }` -> thực thi trước `translateRequest`.
      - `PROJECTED`: Format `kiro` -> áp dụng text projection hiện có.
      - `BYPASS`: Các trường hợp còn lại.
  - `open-sse/rtk/headroomInvariants.js` (Mới):
    - Bảo toàn nghiêm ngặt: `reasoning` (summary, encrypted_content), signatures, opaque metadata, call IDs, thứ tự message, ghép cặp tool call/result, JSON syntax của `arguments`, error flags (`is_error`).
    - Bất kỳ vi phạm nào đều kích hoạt fail-open và khôi phục payload nguyên bản.
  - `open-sse/rtk/headroom.js`:
    - Xóa bỏ `isHeadroomPhantomSavings` và logic roundtrip qua OpenAI.
    - Xuất khẩu hàm facade `compressWithHeadroom` và các hàm log phân tách byte delta và token delta.
  - `src/sse/handlers/chat.js`:
    - Áp dụng `structuredClone(body)` trước mỗi attempt gọi `handleChatCore`.
  - `open-sse/handlers/chatCore.js`:
    - Tách biệt `headroomEligible` khỏi `nativePassthrough` và `strictStructuredOutput`.
    - Tắt PXPIPE khi `tokenSaverEnabled === false`.
    - Chuyển giao `forwardedProviderHeaders` từ Headroom Gateway vào `executor.execute({ ..., customHeaders })`.
- **Trạng thái**: `[Pending Implementation]`

### Phase P2: Bảo mật Dashboard Proxy & Giám sát Vận hành (Observability)
- **Mục tiêu**: Khắc phục lỗi truy cập dashboard từ xa, ngăn chặn triệt để SSRF/credential leak, hiển thị trạng thái chuẩn xác.
- **Tập tin tác động**:
  - `src/dashboardGuard.js`:
    - Bổ sung `/api/headroom/restart` và `/api/headroom/extras` vào `LOCAL_ONLY_PATHS`.
    - Đưa `/api/headroom/proxy/*` vào diện bắt buộc Dashboard JWT hoặc Cloudflare Access JWT (kể cả khi `requireLogin = false`). LLM API key không được cấp quyền admin này.
  - `src/app/api/headroom/proxy/[...path]/route.js`:
    - Chỉ cho phép method `GET` và `HEAD`.
    - Allowlist đường dẫn nghiêm ngặt: chỉ gồm `/health`, `/readyz`, `/stats`, `/stats-history`. Loại bỏ `/dashboard` và `/transformations/feed` (chỉ cho phép truy cập cục bộ).
    - Strip toàn bộ auth headers của client (`Cookie`, `Authorization`, `x-9r-cli-token`), inject `X-Headroom-Proxy-Token`.
    - Strip response headers nhạy cảm (`Set-Cookie`, `Access-Control-*`), thêm `Cache-Control: no-store`.
  - `src/app/api/headroom/status/route.js`:
    - Báo cáo rõ ràng: `reachable`, `ready`, `version`, `gateway_supported`, `managedPid`.
- **Trạng thái**: `[Pending Implementation]`

### Phase P3: Response Usage Relay (Có điều kiện - Gated by Contract Tests)
- **Mục tiêu**: Bổ sung chiều gửi metrics sử dụng (`POST /v1/compress/response`) sau khi request kết thúc thành công, nếu và chỉ nếu toàn bộ contract tests đạt.
- **Tiêu chuẩn kích hoạt**:
  - Chỉ gửi relay khi gateway request trả về `obligations.relay_usage === true`.
  - Relay context khởi tạo theo từng attempt trong `sharedCtx`.
  - Hook hoàn tất duy nhất (`headroomTurnContext.complete(...)`) dùng chung cho `streamingHandler`, `nonStreamingHandler`, `sseToJsonHandler` và trường hợp lỗi pre-sharedCtx.
  - Tuyệt đối không gửi raw response body; chỉ gửi `status`, `latency_ms` và normalized usage mapping (OpenAI, Responses, Anthropic, Gemini tokens) mà không tính trùng lặp (double-count).
  - Tác vụ bất đồng bộ độc lập (non-blocking async), có giới hạn timeout (<= 1500ms), không làm trễ response gửi về client.
  - Turn TTL mặc định 120s, cấu hình được qua `HEADROOM_GATEWAY_TURN_TTL_SECONDS`.
  - Nếu sidecar restart hoặc trả 404, xử lý best-effort và bỏ qua mà không gây gián đoạn hệ thống.
- **Trạng thái**: `[Conditional Implementation - Chỉ bật khi P1/P2 và lifecycle tests pass hoàn toàn]`

### Phase P4: Session Replay & Caching (Tạm hoãn - Deferred)
- **Tiêu chuẩn**: Chỉ nghiên cứu và triển khai khi có bằng chứng đo lường thực tế (benchmark evidence) và cơ chế phân tách tenant/lineage/cache-prefix an toàn.
- **Hiện tại**: Duy trì trạng thái **OFF** (`session_affinity: false`, không gửi `config.session_id`). Không can thiệp logic toàn cục của `sessionManager.js`.
- **Trạng thái**: `[Deferred]`

### Phase P5: Machine Learning (Kompress), Tool Search, CCR & Redrive (Nghiêm cấm - Prohibited)
- **Tiêu chuẩn**: Không triển khai trong phạm vi tích hợp này nhằm đảm bảo tính ổn định tối đa của 9Router.
- Cấu hình bắt buộc: `HEADROOM_DISABLE_KOMPRESS=1`, `HEADROOM_TOOL_SEARCH=0`, `HEADROOM_OUTPUT_SHAPER=0`, `HEADROOM_MODEL_ROUTER_ENABLED=0`, `can_redrive: false`.
- **Trạng thái**: `[Prohibited / Disabled]`

---

## 3. Ma trận Tương thích & Pure Stage Selector Chuẩn hóa

| Nguồn Client | Đích Provider | Pure Stage Selection | Điểm Thực thi Nén | Xử lý Đặc thù & Căn cứ Source Evidence |
| :--- | :--- | :--- | :--- | :--- |
| OpenAI Chat | OpenAI Chat | `TARGET_NATIVE` | Sau translate (passthrough) | Nén native `messages[]` |
| OpenAI Responses (Codex) | OpenAI Responses (Codex) | `TARGET_NATIVE` | Sau translate (passthrough) | Nén native `input[]`, bảo toàn reasoning & call_id |
| Claude Messages | Claude Messages | `TARGET_NATIVE` | Sau translate (passthrough) | Nén native Claude `messages[]` + `system` |
| OpenAI Responses (Codex) | Antigravity / Gemini | `SOURCE_NATIVE` | **Trước translateRequest** | Nén native Responses `input[]` trước; sau đó 9Router dịch sang Google `contents[]` |
| Claude Messages | Antigravity / Gemini | `SOURCE_NATIVE` | **Trước translateRequest** | Nén native Claude format trước; sau đó 9Router dịch sang Google `contents[]` |
| Gemini / Antigravity | OpenAI Chat | `TARGET_NATIVE` | Sau translateRequest | 9Router dịch sang OpenAI trước, nén OpenAI format sau |
| Antigravity (Gemini) | Antigravity (Gemini) | `BYPASS` | Không áp dụng | Cấm nén, tránh làm hỏng Google contents[] |
| Bất kỳ format | Kiro (EventStream) | `PROJECTED` | Trong translate hook | Dùng projection in-place hiện có, map ngược lại Kiro structure |
| Cursor / Protobuf | Bất kỳ | `BYPASS` | Không áp dụng | Bypass hoàn toàn, bảo toàn protobuf/binary |

---

## 4. Thiết kế Runner Kiểm thử Nghiệm thu (`tests/headroom-acceptance.sh`)

Script chạy kiểm thử nghiệm thu được thiết kế độc lập, bảo đảm môi trường cách ly hoàn toàn (`HOME` và `DATA_DIR` tạm thời trong `/tmp`), không sử dụng credentials thực của provider, trả mã thoát khác 0 nếu có bất kỳ kiểm tra bắt buộc nào thất bại.

### 4.1. Chế độ Chạy
1. **Chế độ Nhanh (`--fast` / Mặc định)**:
   - Chạy toàn bộ các unit test mới của Headroom Gateway v2.
   - Kiểm tra tính bất biến của body (reasoning, tool pairing, error flags, arguments JSON).
   - Kiểm tra Pure Stage Selector cho tất cả các cặp định dạng (bao gồm cả Antigravity `SOURCE_NATIVE` và `BYPASS`).
   - Kiểm tra bảo mật proxy route và các middleware guard (`LOCAL_ONLY_PATHS` gồm extras và restart).
2. **Chế độ Đầy đủ (`--strong`)**:
   - Bao gồm toàn bộ các bước của chế độ Fast.
   - Chạy offline regression suites bị ảnh hưởng (translator coverage, lifecycle 524, preResponse deadline).
   - Kiểm tra cú pháp và quy chuẩn mã nguồn: `bunx --no-install eslint` cho các file JS thay đổi.
   - Kiểm tra biên dịch ứng dụng: `bun run build`.
   - Kiểm tra cấu hình Docker Compose với môi trường synthetic (`docker compose config` - yêu cầu docker binary nếu có).
   - Kiểm tra contract fidelity với mock/synthetic gateway sidecar.
   - Chạy benchmark tổng hợp (Synthetic Benchmark Suite).

### 4.2. Hiện đại hóa Test Fixtures
Toàn bộ các file test cũ sẽ được nâng cấp lên Gateway v2:
- `tests/unit/headroom-responses-format.test.js`:
  - Thay thế mock cũ `{ messages: [...] }` bằng `{ data: { body, turn_id, obligations, headers } }`.
  - Xóa bỏ assertion kỳ vọng skip đối với Responses có tool/reasoning; thay bằng assertion kiểm tra Responses items được bảo toàn nguyên vẹn sau nén.
- `tests/unit/headroom.test.js`:
  - Cập nhật mock contracts và test cases cho Pure Stage Selector và Invariants Guard.

---

## 5. Kế hoạch Phục hồi (Rollback Plan)

Trong trường hợp phát sinh sự cố không mong muốn trong môi trường sản xuất:
1. **Tắt tức thời qua cấu hình**: Chuyển `headroomEnabled: false` trong Settings dashboard hoặc gửi header `x-9r-token-saver: off` (hoặc `x-9router-token-saver: off`).
2. **Biến môi trường khẩn cấp**: Đặt `HEADROOM_ENABLED=false` trong `.env` và restart container.
3. **Bảo toàn dữ liệu**: Tuyệt đối không xóa database SQLite (`DATA_DIR/db/data.sqlite`). Các migration hoặc cấu hình chỉ cập nhật trường giá trị, không làm thay đổi cấu trúc bảng cốt lõi.
4. **Không thay đổi phiên bản**: Không tự ý nâng số phiên bản (`version` trong `package.json` hoặc CLI) ngoài phạm vi phê duyệt của release.

---

## 6. Bảng Phân loại Trạng thái Chi tiết (Sau Triển khai & Nghiệm thu)

| Thành phần | Trạng thái | Ghi chú & Căn cứ Nguồn tham chiếu |
| :--- | :--- | :--- |
| Gateway Native Contract (POST /v1/compress) | `[Implemented & Verified]` | Upstream 0.38.0 commit `94206e2`; `open-sse/rtk/headroomGateway.js` bóc tách data.body, turn_id, provider request headers. |
| Provider Request Headers Forwarding | `[Implemented & Verified]` | `open-sse/executors/base.js` và `chatCore.js`: chuyển tiếp forwardedProviderHeaders vào executor.execute({ customHeaders }). |
| Pure Stage Selector | `[Implemented & Verified]` | `open-sse/rtk/headroomStage.js`: TARGET_NATIVE / SOURCE_NATIVE (Antigravity) / PROJECTED (Kiro) / BYPASS. |
| Body Invariants Guard | `[Implemented & Verified]` | `open-sse/rtk/headroomInvariants.js`: bảo toàn 100% reasoning/encrypted/signatures, call IDs, JSON args, message order. |
| Request Deep Cloning for Fallback | `[Implemented & Verified]` | `src/sse/handlers/chat.js:512`: structuredClone(body) trước mỗi attempt ngăn nén lặp. |
| Decoupled Eligibility & PXPIPE Kill-switch | `[Implemented & Verified]` | `open-sse/config/runtimeConfig.js` & `chatCore.js`: hỗ trợ 2 alias headers; kill-switch off tắt cả PXPIPE. |
| Budget Exhaustion Early Bypass | `[Implemented & Verified]` | `open-sse/rtk/headroomGateway.js`: budget <= 0ms lập tức bypass với `reason: budget_exhausted`. |
| Dashboard Security Proxy Hardening | `[Implemented & Verified]` | `src/app/api/headroom/proxy/[...path]/route.js`: GET/HEAD only, exact JSON allowlist, strip auth, origin-bound token. |
| LOCAL_ONLY_PATHS Hardening | `[Implemented & Verified]` | `src/dashboardGuard.js`: thêm /api/headroom/restart và /api/headroom/extras vào LOCAL_ONLY_PATHS. |
| Pinned Docker Compose & 1024M RAM | `[Implemented & Verified]` | `docker-compose.yml` & `docker-compose.prod.yml`: ghcr.io/headroomlabs-ai/headroom:0.38.0, 1024M RAM, 0.38 env flags, sidecar token blue/green. |
| Pip Install Version Pinning | `[Implemented & Verified]` | `src/lib/headroom/process.js`: headroom-ai[...]==0.38.0, loại bỏ --upgrade unpinned, thêm isHeadroomProcess kiểm tra pid cmdline. |
| Gateway v2 Test Modernization | `[Implemented & Verified]` | Cập nhật `headroom-responses-format.test.js`, `headroom.test.js`, `headroom-chat-core.test.js`. |
| Loại bỏ 5% JSON Billing Heuristic | `[Implemented & Verified]` | Xóa bỏ isHeadroomPhantomSavings và warning 5% JSON size; log rõ byte delta và token delta. |
| Response Usage Relay (Phase P3) | `[Implemented & Verified]` | `open-sse/rtk/headroomRelay.js`: chỉ kích hoạt khi obligations.relay_usage=true, complete-once per attempt, chuẩn hóa usage không tính trùng, async 1500ms không cản client. |
| Session Replay (Phase P4) | `[Deferred / OFF]` | Giữ nguyên trạng thái OFF/Deferred cho tới khi có benchmark và tenant evidence rõ ràng. |
| CCR & Model Router (Phase P5) | `[Prohibited / OFF]` | Nghiêm cấm kích hoạt, giữ các env cờ tắt `HEADROOM_DISABLE_KOMPRESS=1`, `HEADROOM_TOOL_SEARCH=0`, `HEADROOM_MODEL_ROUTER_ENABLED=0`. |
| Acceptance Runner Script | `[Implemented & Verified]` | `tests/headroom-acceptance.sh`: hỗ trợ cả `--fast` và `--strong`, kiểm tra môi trường cách ly, 33/33 headroom unit tests pass, 108/108 regression tests pass, eslint pass, next build pass. |

