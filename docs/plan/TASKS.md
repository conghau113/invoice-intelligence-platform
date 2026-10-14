# Sổ theo dõi task (Task Ledger)

> Nguồn sự thật về tiến độ. Agent và bạn cập nhật file này sau MỖI task (trạng thái + ghi chú + giờ thực tế).
> Chi tiết từng task nằm trong `docs/plan/milestones/M*.md`. Sinh tự động lần đầu; sau đó sửa tay.

## Trạng thái


| Trạng thái | Nghĩa                                                   |
| ---------- | ------------------------------------------------------- |
| `TODO`     | Chưa bắt đầu                                            |
| `DOING`    | Đang làm (chỉ 1 task tại một thời điểm)                 |
| `REVIEW`   | Agent làm xong, chờ bạn đọc diff + chạy thử + cổng hiểu |
| `DONE`     | Qua cổng hiểu, đã commit                                |
| `BLOCKED`  | Bị chặn, ghi lý do                                      |
| `CUT`      | Cắt khỏi phạm vi, ghi lý do                             |




## Điểm dừng hiện tại

```text
Mốc hiện tại: M0
Task hiện tại: T0.6 (T0.0, T0.1, T0.2, T0.3, T0.4, T0.5 đã DONE)
Chặn bởi: không
Cập nhật: 2026-10-14
```



## M0 — Nền móng repo & công cụ


| ID   | Task                                                                                  | Ước tính (h) | Phụ thuộc        | Trạng thái | Thực tế (h) | Ghi chú                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------- | ------------ | ---------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| T0.0 | Chuẩn bị môi trường: WSL2 Ubuntu, Docker Desktop, Node, pnpm, uv, Claude Code, Cursor | 2            | —                | `DONE`     | 1           | Cursor mở ~/code qua WSL: Hậu xác nhận. Gemini key đã tạo (không billing), lưu ngoài repo; sẽ đưa vào apps/ai/.env khi dự án khởi tạo xong |
| T0.1 | Khởi tạo repo, pnpm workspace, Turborepo                                              | 1.5          | T0.0             | `DONE`     | 1           |                                                                                                                                            |
| T0.2 | Scaffold apps/web (Next.js + TS strict + Tailwind + shadcn/ui)                        | 2            | T0.1             | `DONE`     | 1           | Next 16.4, Tailwind 4, shadcn radix-nova. Licence gián tiếp (LGPL sharp-libvips...) hoãn T7.4, xem Phát sinh                               |
| T0.3 | Scaffold apps/api (NestJS) + config validation                                        | 2            | T0.1             | `DONE`     | 2           | Ghim Nest 11 (CJS) vì Nest 12 chỉ ESM, xem Phát sinh. api cổng 3001, `NODE_ENV` bắt buộc                                                   |
| T0.4 | Scaffold apps/ai (FastAPI + uv + pytest)                                              | 2            | T0.1             | `DONE`     | 1.5         | Cổng 8000. Python 3.12, uv, package=false (layout `app/`). `package.json` bọc `uv run` để Turborepo gọi được                               |
| T0.5 | packages/contracts: schema Zod dùng chung + xuất JSON Schema cho Python               | 2            | T0.2, T0.3, T0.4 | `DONE`     | 1.5         |                                                                                                                                            |
| T0.6 | docker-compose dev: Postgres+pgvector, Redis, Keycloak                                | 3            | T0.3             | `TODO`     |             |                                                                                                                                            |
| T0.7 | Cổng chất lượng & CI (GitHub Actions)                                                 | 2.5          | T0.5, T0.6       | `TODO`     |             |                                                                                                                                            |
| T0.8 | Script kiểm tra repo: i18n parity, ADR index, docs links                              | 1.5          | T0.7             | `TODO`     |             |                                                                                                                                            |
| T0.9 | Cập nhật CLAUDE.md lệnh thật + kiểm tra Claude Code hiểu dự án                        | 1            | T0.8             | `TODO`     |             |                                                                                                                                            |




## M1 — Danh tính, đa tenant, phân quyền, i18n


| ID    | Task                                                                                 | Ước tính (h) | Phụ thuộc         | Trạng thái | Thực tế (h) | Ghi chú |
| ----- | ------------------------------------------------------------------------------------ | ------------ | ----------------- | ---------- | ----------- | ------- |
| T1.1  | Keycloak realm-as-code: organizations, roles, demo users                             | 3            | T0.6              | `TODO`     |             |         |
| T1.2  | API: xác thực JWT qua JWKS, CurrentUser, TenantContext                               | 3            | T1.1              | `TODO`     |             |         |
| T1.3  | DB: Drizzle, migrations, bảng lõi, Row-Level Security                                | 4            | T1.2              | `TODO`     |             |         |
| T1.4  | RBAC: ma trận quyền, @RequirePermission, test chính sách                             | 3            | T1.3              | `TODO`     |             |         |
| T1.5  | Web: đăng nhập Keycloak, session, refresh token, route bảo vệ                        | 3            | T1.1, T0.2        | `TODO`     |             |         |
| T1.6  | i18n vi/en với next-intl + định dạng số/tiền/ngày theo locale                        | 3            | T0.2              | `TODO`     |             |         |
| T1.6b | Design baseline với ui-ux-pro-max (màu, chữ, khoảng cách, trạng thái, accessibility) | 2.5          | T1.6              | `TODO`     |             |         |
| T1.7  | App shell: layout, menu theo quyền, chuyển tenant                                    | 2.5          | T1.4, T1.5, T1.6b | `TODO`     |             |         |
| T1.8  | Test: cách ly tenant (Testcontainers) + e2e đăng nhập (Playwright)                   | 3            | T1.7              | `TODO`     |             |         |




## M2 — Upload, danh sách & lát cắt xuyên suốt bằng XML


| ID    | Task                                                                        | Ước tính (h) | Phụ thuộc        | Trạng thái | Thực tế (h) | Ghi chú |
| ----- | --------------------------------------------------------------------------- | ------------ | ---------------- | ---------- | ----------- | ------- |
| T2.1  | StoragePort + adapter filesystem local; upload qua API có kiểm tra file     | 3            | T1.8             | `TODO`     |             |         |
| T2.2  | Bảng documents + máy trạng thái                                             | 2.5          | T2.1             | `TODO`     |             |         |
| T2.3  | API tạo tài liệu + idempotency theo content hash                            | 2.5          | T2.2             | `TODO`     |             |         |
| T2.4  | Hàng đợi BullMQ: producer, worker, retry, dead-letter                       | 3            | T2.3             | `TODO`     |             |         |
| T2.5  | Web: màn hình upload kéo thả                                                | 3            | T2.3, T1.7       | `TODO`     |             |         |
| T2.6  | Danh sách tài liệu: phân trang server, lọc, sắp xếp                         | 3            | T2.3, T1.7       | `TODO`     |             |         |
| T2.7  | Chốt schema hóa đơn + độ tin cậy từng field                                 | 2            | T0.5             | `TODO`     |             |         |
| T2.8  | Parser hóa đơn điện tử XML (đường xác định, không dùng LLM)                 | 3            | T2.7             | `TODO`     |             |         |
| T2.9  | Lát cắt xuyên suốt: worker gọi AI service (XML) → lưu extraction → hiển thị | 3.5          | T2.4, T2.6, T2.8 | `TODO`     |             |         |
| T2.10 | Audit log + test luồng upload end-to-end                                    | 2            | T2.5, T2.9       | `TODO`     |             |         |




## M3 — AI trích xuất PDF/ảnh & form kiểm tra


| ID   | Task                                                         | Ước tính (h) | Phụ thuộc         | Trạng thái | Thực tế (h) | Ghi chú |
| ---- | ------------------------------------------------------------ | ------------ | ----------------- | ---------- | ----------- | ------- |
| T3.1 | FastAPI /extract: provider abstraction + structured output   | 4            | T2.8              | `TODO`     |             |         |
| T3.2 | Worker: đường LLM, timeout, phân loại lỗi tạm thời/vĩnh viễn | 2.5          | T3.1, T2.9        | `TODO`     |             |         |
| T3.3 | Kiểm tra nghiệp vụ: tổng tiền, thuế, MST, ngày               | 2.5          | T3.2              | `TODO`     |             |         |
| T3.4 | Form review: RHF + Zod, xem tài liệu song song, tô field yếu | 4            | T3.3, T2.9, T1.6b | `TODO`     |             |         |
| T3.5 | Duyệt/sửa: lưu bản sửa và diff AI vs người                   | 2.5          | T3.4              | `TODO`     |             |         |
| T3.6 | Phòng prompt injection & rò PII trong pipeline trích xuất    | 2            | T3.1              | `TODO`     |             |         |




## M4 — Đo độ chính xác AI + bản demo đầu tiên (bắt đầu nộp hồ sơ)


| ID   | Task                                                               | Ước tính (h) | Phụ thuộc  | Trạng thái | Thực tế (h) | Ghi chú |
| ---- | ------------------------------------------------------------------ | ------------ | ---------- | ---------- | ----------- | ------- |
| T4.1 | Bộ sinh hóa đơn tổng hợp: JSON đáp án + XML + PDF/ảnh              | 4            | T2.7       | `TODO`     |             |         |
| T4.2 | Chốt bộ dữ liệu đánh giá và ngưỡng chấp nhận                       | 1.5          | T4.1       | `TODO`     |             |         |
| T4.3 | Eval runner: độ chính xác từng field, line items, chi phí, độ trễ  | 4            | T4.2, T3.1 | `TODO`     |             |         |
| T4.4 | So sánh 2 model/prompt + phân tích lỗi                             | 3            | T4.3       | `TODO`     |             |         |
| T4.5 | CI: chạy eval smoke set thủ công/định kỳ có ngưỡng                 | 2            | T4.3       | `TODO`     |             |         |
| T4.6 | Trang số liệu AI trong web                                         | 2.5          | T4.3, T3.5 | `TODO`     |             |         |
| T4.7 | Deploy demo chỉ-xem lên Oracle Always Free (ARM) + DuckDNS + Caddy | 5            | T4.6       | `TODO`     |             |         |
| T4.8 | README bản 1 + GIF demo để bắt đầu nộp hồ sơ                       | 2            | T4.7       | `TODO`     |             |         |




## M5 — Hỏi đáp RAG có trích dẫn


| ID   | Task                                                          | Ước tính (h) | Phụ thuộc  | Trạng thái | Thực tế (h) | Ghi chú |
| ---- | ------------------------------------------------------------- | ------------ | ---------- | ---------- | ----------- | ------- |
| T5.1 | Chiến lược chunk & metadata cho hóa đơn đã duyệt              | 2.5          | T3.5       | `TODO`     |             |         |
| T5.2 | Embedding + pgvector HNSW + job index khi duyệt               | 3            | T5.1       | `TODO`     |             |         |
| T5.3 | Truy hồi hybrid (vector + full-text) với RRF, lọc tenant      | 3.5          | T5.2       | `TODO`     |             |         |
| T5.4 | Sinh câu trả lời có trích dẫn + công cụ truy vấn số liệu      | 4            | T5.3       | `TODO`     |             |         |
| T5.5 | Giao diện hỏi đáp streaming + mở nguồn trích dẫn              | 3.5          | T5.4       | `TODO`     |             |         |
| T5.6 | Đánh giá RAG: 30 câu golden, hit@k, trích dẫn đúng, bám nguồn | 3.5          | T5.4, T4.3 | `TODO`     |             |         |
| T5.7 | Test rò dữ liệu chéo tenant & injection qua tài liệu đã lưu   | 2            | T5.4       | `TODO`     |             |         |




## M6 — Chịu tải & chịu lỗi: rate limit, 429, cache, realtime


| ID   | Task                                                                        | Ước tính (h) | Phụ thuộc  | Trạng thái | Thực tế (h) | Ghi chú |
| ---- | --------------------------------------------------------------------------- | ------------ | ---------- | ---------- | ----------- | ------- |
| T6.1 | Rate limit API bằng token bucket trong Redis                                | 3            | T2.4       | `TODO`     |             |         |
| T6.2 | Xử lý 429 của provider LLM: backoff, rate limiter hàng đợi, circuit breaker | 3            | T3.2       | `TODO`     |             |         |
| T6.3 | Cache: cache-aside cho danh sách/dashboard + cache kết quả theo hash file   | 3            | T2.6, T3.2 | `TODO`     |             |         |
| T6.4 | Realtime tiến độ bằng Socket.IO + Redis adapter                             | 4            | T3.2, T1.5 | `TODO`     |             |         |
| T6.5 | Thông báo trong app + ADR WebSocket vs FCM                                  | 2            | T6.4       | `TODO`     |             |         |
| T6.6 | Load test k6 + báo cáo                                                      | 3            | T6.1, T6.3 | `TODO`     |             |         |
| T6.7 | Diễn tập sự cố: tắt AI service/Redis giữa chừng                             | 2            | T6.2, T6.4 | `TODO`     |             |         |




## M7 — Quan sát hệ thống, bảo mật, deploy tự động


| ID   | Task                                                                             | Ước tính (h) | Phụ thuộc  | Trạng thái | Thực tế (h) | Ghi chú |
| ---- | -------------------------------------------------------------------------------- | ------------ | ---------- | ---------- | ----------- | ------- |
| T7.1 | OpenTelemetry xuyên 4 dịch vụ (kể cả qua hàng đợi)                               | 4            | T6.4       | `TODO`     |             |         |
| T7.2 | Log có cấu trúc + trace_id + che PII                                             | 2.5          | T7.1       | `TODO`     |             |         |
| T7.3 | Metrics + dashboard + 2 cảnh báo                                                 | 3            | T7.1       | `TODO`     |             |         |
| T7.4 | Bảo mật: checklist ASVS rút gọn, quét phụ thuộc, header, CSP                     | 3            | T7.2       | `TODO`     |             |         |
| T7.5 | CD: build image multi-arch → GHCR → deploy Oracle VM, migration, backup, runbook | 5            | T4.7, T7.4 | `TODO`     |             |         |
| T7.6 | Core Web Vitals: Lighthouse CI + sửa                                             | 2.5          | T7.5       | `TODO`     |             |         |
| T7.7 | Dữ liệu demo hoàn chỉnh + kịch bản demo 3 phút                                   | 1.5          | T7.5       | `TODO`     |             |         |




## M8 — Đóng gói hồ sơ & luyện phỏng vấn


| ID   | Task                                                         | Ước tính (h) | Phụ thuộc | Trạng thái | Thực tế (h) | Ghi chú |
| ---- | ------------------------------------------------------------ | ------------ | --------- | ---------- | ----------- | ------- |
| T8.1 | README hoàn chỉnh + 'How I used AI'                          | 3            | T7.7      | `TODO`     |             |         |
| T8.2 | Hoàn thiện tài liệu kiến trúc: C4 1–3, ADR ≥ 15, NFR đo được | 2            | T8.1      | `TODO`     |             |         |
| T8.3 | Video demo 3–5 phút                                          | 2            | T7.7      | `TODO`     |             |         |
| T8.4 | Cập nhật CV + LinkedIn                                       | 2            | T8.1      | `TODO`     |             |         |
| T8.5 | Ngân hàng 20 câu trade-off + phỏng vấn thử                   | 4            | T8.2      | `TODO`     |             |         |
| T8.6 | Retrospective + danh sách nợ kỹ thuật                        | 1            | T8.5      | `TODO`     |             |         |




## Tùy chọn (không tính vào timeline; mục có chi phí cần bạn duyệt trước)


| ID  | Task                                                                        | Ước tính (h) | Chi phí                       | Ghi chú                                                            | Trạng thái |
| --- | --------------------------------------------------------------------------- | ------------ | ----------------------------- | ------------------------------------------------------------------ | ---------- |
| O1  | Adapter SeaweedFS (S3-compatible, Apache 2.0) + presigned URL               | 4            | 0đ                            | Sau M4. Học S3 API; dùng lại contract test của StoragePort (T2.1). | `TODO`     |
| O2  | Deploy dịch vụ AI lên Azure Container Apps + ADR + hướng dẫn tắt tài nguyên | 5            | Cần thẻ, có thể phát sinh phí | Chỉ làm khi bạn duyệt chi phí. Sau M7.                             | `TODO`     |
| O3  | FCM web push cho người dùng offline                                         | 4            | 0đ (cần dự án Firebase)       | Sau M6. Bổ sung cho ADR 0014.                                      | `TODO`     |
| O4  | Mua tên miền riêng thay DuckDNS                                             | 1            | Phí hằng năm                  | Chỉ khi bạn duyệt.                                                 | `TODO`     |




## Phát sinh (việc mới phát hiện khi làm task — không làm ngay, xếp lịch sau)


| Ngày       | Phát hiện ở task | Mô tả                                                                                                                                                                                                                                                                                                                                                                                  | Quyết định                                                                                                               |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-12 | T0.0             | pnpm Windows (`/mnt/c/nvm4w/nodejs/pnpm`) còn trong PATH WSL, từng bị chọn nhầm và panic. Cân nhắc: preflight Node (.mjs) báo lỗi nếu pnpm nằm dưới `/mnt/c/` hoặc lệch `packageManager`; hoặc tắt `appendWindowsPath` trong `/etc/wsl.conf` (có tác dụng phụ, cần Hậu quyết)                                                                                                          | Chờ quyết khi tới T0.8 (đang ngoài spec T0.8)                                                                            |
| 2026-10-12 | T0.0             | Thêm mục troubleshooting "pnpm trỏ nhầm bản Windows" (`which -a pnpm`, corepack enable) vào `docs/setup/WSL2.md`                                                                                                                                                                                                                                                                       | Chờ xếp lịch                                                                                                             |
| 2026-10-12 | T0.1             | Task `dev` (persistent, không cache) + script `dev` ở gốc cho `pnpm dev` (CLAUDE.md)                                                                                                                                                                                                                                                                                                   | Chờ xếp lịch (T0.9)                                                                                                      |
| 2026-10-12 | T0.1             | `env`/`globalEnv` trong `turbo.json` (strict env mode chặn biến như `NEXT_PUBLIC_*`, `DATABASE_URL`)                                                                                                                                                                                                                                                                                   | T0.2 chưa có biến env nào nên chưa cần; để T0.3/T1.x khi có biến đầu tiên                                                |
| 2026-10-12 | T0.1             | `onlyBuiltDependencies` trong `pnpm-workspace.yaml` khi thêm package có postinstall (sharp, esbuild, @nestjs/core)                                                                                                                                                                                                                                                                     | T0.2 đã xử lý: pnpm 12 ghi `allowBuilds: unrs-resolver: false` trong `pnpm-workspace.yaml`. T0.3 xử lý tiếp nếu Nest cần |
| 2026-10-12 | T0.1             | `tsconfig.base.json` chỉ giữ cờ strict; `module`, `moduleResolution`, `lib`, `target` do từng app tự ghi đè (Next: bundler + DOM; Nest: CommonJS + decorators)                                                                                                                                                                                                                         | T0.2 đã làm cho web (`apps/web/tsconfig.json`); T0.3 làm cho api                                                         |
| 2026-10-12 | T0.1             | `packages/contracts`: build ra `dist/` hay trỏ `exports` vào source `.ts` (ảnh hưởng `typecheck/test dependsOn ^build`)                                                                                                                                                                                                                                                                | Hậu chốt ở T0.5                                                                                                          |
| 2026-10-13 | T0.2             | Quét licence gói gián tiếp của `apps/web`: ngoài allow-list có `@img/sharp-libvips-linux-x64` (LGPL-3.0-or-later, binary native do `sharp` của Next kéo vào, liên kết động), `caniuse-lite` (CC-BY-4.0, dữ liệu), `isexe`/`minimatch` (BlueOak-1.0.0), `language-subtag-registry` (CC0-1.0), `tslib` (0BSD), `type-fest` (MIT OR CC0-1.0). Theo LEGAL.md cần mục review trước khi dùng | Hậu quyết 2026-10-13: hoãn tới T7.4 (CI enforce licence), chưa ghi `docs/LEGAL.md` ở T0.2                                |
| 2026-10-13 | T0.2             | `next/font/google` (Geist, do shadcn init thêm) tải font lúc build, cần mạng; Next cũng bật telemetry ẩn danh mặc định                                                                                                                                                                                                                                                                 | Cân nhắc font self-host và `NEXT_TELEMETRY_DISABLED=1` khi làm T1.6b/T0.7                                                |
| 2026-10-13 | T0.2             | `layout.tsx` đặt `lang="vi"` cứng và `page.tsx` dùng text tạm                                                                                                                                                                                                                                                                                                                          | Thay bằng next-intl ở T1.6                                                                                               |
| 2026-10-13 | T0.3             | NestJS 12 (mới nhất) và `@nestjs/cli` 12 chỉ phát hành ESM; Jest/CJS không chạy được. Đã ghim `@nestjs/*` 11 + `@nestjs/config` 4 (CommonJS, MIT). Cần cân nhắc nâng lên Nest 12 (ESM, nodenext, Vitest+SWC) và ghi ADR                                                                                                                                                                | Chờ xếp lịch (sau M0, trước khi code api nhiều)                                                                          |
| 2026-10-14 | T0.4             | `apps/ai/.env.example` bị quyền ghi chặn nên chưa tạo; cần Hậu tạo tay với ENV, PORT, LOG_LEVEL (xem `app/config.py`)                                                                                                                                                                                                                                                                  | Hậu đã tạo tay; xong                                                                                                     |
| 2026-10-14 | T0.4             | `fastapi.testclient` cảnh báo httpx deprecated, đề nghị `httpx2`; cân nhắc đổi dev dependency khi có bản ổn định và kiểm licence                                                                                                                                                                                                                                                       | Chờ xếp lịch (T0.7)                                                                                                      |
| 2026-10-14 | T0.4 | Thiếu test dùng `from app.main import app` (object Uvicorn thật sự lấy); sửa dòng cuối `main.py` sai thì pytest vẫn xanh | Xử lý khi có dịp chạm `apps/ai` (T0.5 hoặc T0.7) |
| 2026-10-14 | T0.4 | `Settings.port`/`log_level` chưa có tác dụng (Dockerfile và `package.json` ghi cứng cổng 8000, chưa cấu hình logging) | Nối khi cần ở T0.6 (compose) hoặc T3.1 |
| 2026-10-14 | T0.4 | `apps/ai` `typecheck` chỉ là `echo`; chưa có mypy/pyright cho code Python (kể cả `generated.py` ở T0.5) | Quyết ở T0.7 (cổng chất lượng và CI) |
| 2026-10-14 | T0.4 | Dockerfile `apps/ai` chưa có `HEALTHCHECK`; bind `0.0.0.0:8000`, `/health` không xác thực; chưa tách liveness và readiness | T0.6: chỉ expose trong mạng nội bộ compose, thêm healthcheck; readiness khi có provider (T3.1) |
| 2026-10-14 | T0.4 | `.dockerignore` của `apps/ai` thiếu mẫu file env (an toàn hiện tại vì Dockerfile chỉ COPY `app`) | Thêm khi sửa Dockerfile ở T0.6 |
| 2026-10-13 | T0.3             | `turbo test` cảnh báo "no output files" cho api vì `outputs: coverage/**` chưa có coverage                                                                                                                                                                                                                                                                                             | Bỏ qua tới khi bật coverage (T0.7)                                                                                       |
| 2026-10-13 | T0.3             | `pnpm-workspace.yaml`: thêm `allowBuilds: '@parcel/watcher': false` (postinstall chỉ là fallback, có binary dựng sẵn)                                                                                                                                                                                                                                                                  | Đã làm trong T0.3                                                                                                        |


| 2026-10-14 | T0.5 | Bước drift (`pnpm --filter contracts check:drift`) mới là lệnh chạy tay; CI chưa gọi nó | Nối vào GitHub Actions và `check:full` ở T0.7 |
| 2026-10-14 | T0.5 | `contracts` build CommonJS (khớp apps/api `node10`); chưa có app nào import. Khi web/api import, kiểm tra resolve và cân nhắc dual ESM/CJS nếu nâng Nest 12 | Xem lại khi T1.2 / T2.x lần đầu import `contracts` |
| 2026-10-14 | T0.5 | `generated.py` dùng `--strict-types` để pydantic không ép kiểu như Zod (chuỗi "1100000" không thành int); ngày ISO hai bên có thể lệch ở biên (datetime vs date) | Mở rộng fixture khi làm T2.7 |
| 2026-10-14 | T0.5 | Reviewer: `issueDate` ở Python là `date` (không strict), nhận cả `"2026-03-15T00:00:00"` và số nguyên `1773532800` trong khi Zod từ chối; JSON Schema có `pattern` nhưng pydantic bỏ qua. Cũng sinh hai lớp `Seller`/`Buyer` thay vì một `Party` | Xử lý ở T2.7: đặt `.meta({id})` cho Party, ép pattern cho ngày, thêm fixture |
