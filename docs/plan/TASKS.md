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
Mốc hiện tại: M1
Task hiện tại: T1.6 (T0.0 đến T0.9, T1.1 đến T1.5 đã DONE)
Chặn bởi: không
Cập nhật: 2026-10-18
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
| T0.6 | docker-compose dev: Postgres+pgvector, Redis, Keycloak                                | 3            | T0.3             | `DONE`     |             |                                                                                                                                            |
| T0.7 | Cổng chất lượng & CI (GitHub Actions)                                                 | 2.5          | T0.5, T0.6       | `DONE`     |             |                                                                                                                                            |
| T0.8 | Script kiểm tra repo: i18n parity, ADR index, docs links                              | 1.5          | T0.7             | `DONE`     |             | `pnpm check` gộp 4 cổng; job CI `repo-checks`; i18n tự nghiêm khi có next-intl (xem Phát sinh)                                             |
| T0.9 | Cập nhật CLAUDE.md lệnh thật + kiểm tra Claude Code hiểu dự án                        | 1            | T0.8             | `DONE`     |             |                                                                                                                                            |




## M1 — Danh tính, đa tenant, phân quyền, i18n


| ID    | Task                                                                                 | Ước tính (h) | Phụ thuộc         | Trạng thái | Thực tế (h) | Ghi chú |
| ----- | ------------------------------------------------------------------------------------ | ------------ | ----------------- | ---------- | ----------- | ------- |
| T1.1  | Keycloak realm-as-code: organizations, roles, demo users                             | 3            | T0.6              | `DONE`     |             | Realm import OK (26.4): org UUID cố định, membership, secret qua biến. User nhiều tenant chỉ có claim khi xin `organization:*` (xem Phát sinh) |
| T1.2  | API: xác thực JWT qua JWKS, CurrentUser, TenantContext                               | 3            | T1.1              | `DONE`     |             | Guard jose + JWKS, `/auth/me`; token thiếu/đa tenant → 403. Sửa realm: thêm scope `basic` (xem Phát sinh) |
| T1.3  | DB: Drizzle, migrations, bảng lõi, Row-Level Security                                | 4            | T1.2              | `DONE`     |             | Agent: drizzle-kit + migration RLS tay (role `invoice_app`, FORCE, `app_current_tenant()`), `TenantDbService` + interceptor, tra tenant qua DB, readiness DB; `users.id` = Keycloak `sub`. 49 unit + 19 tích hợp (`test:int`, chạy tay); drill tắt RLS → đỏ. Sau code-review: sửa tra tenant (0002, bỏ SECURITY DEFINER vì hỏng với owner không phải superuser), shutdown hook, `db:*` không xoá `dist/`. DB/role tạm đã được Hậu xoá |
| T1.4  | RBAC: ma trận quyền, @RequirePermission, test chính sách                             | 3            | T1.3              | `DONE`       |             | Agent: `permissions.ts` (ma trận 3 role × 7 permission), `@RequirePermission`/`@AnyAuthenticated`, `PermissionsGuard` deny-by-default (route không khai báo → 403), Problem Details có `code`, `/auth/me` trả `permissions`. 81 test pass; drill đổi ma trận / bỏ guard → đỏ |
| T1.5  | Web: đăng nhập Keycloak, session, refresh token, route bảo vệ                        | 3            | T1.1, T0.2        | `DONE`     |             | Agent: `next-auth` 4.24.15 (v5 còn beta), `proxy.ts` refresh + ghi lại cookie (RSC không set được cookie), single-flight chống race khi xoay refresh token, logout POST same-origin → end_session. 28 test web; kiểm với Keycloak thật: login/refresh/logout/SSO. Realm: `revokeRefreshToken` |
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
| 2026-10-12 | T0.1             | Task `dev` (persistent, không cache) + script `dev` ở gốc cho `pnpm dev` (CLAUDE.md)                                                                                                                                                                                                                                                                                                   | Chuyển thành quyết định ở dòng T0.9 (2026-10-17)                                                                                                      |
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
| 2026-10-14 | T0.4 | `apps/ai` `typecheck` chỉ là `echo`; chưa có mypy/pyright cho code Python (kể cả `generated.py` ở T0.5) | T0.7 quyết: chưa thêm type checker Python (thêm phụ thuộc, ngoài spec); ruff vẫn chạy ở job `python`. Chờ Hậu quyết có thêm pyright/mypy không |
| 2026-10-14 | T0.4 | Dockerfile `apps/ai` chưa có `HEALTHCHECK`; bind `0.0.0.0:8000`, `/health` không xác thực; chưa tách liveness và readiness | T0.6: chỉ expose trong mạng nội bộ compose, thêm healthcheck; readiness khi có provider (T3.1) |
| 2026-10-14 | T0.4 | `.dockerignore` của `apps/ai` thiếu mẫu file env (an toàn hiện tại vì Dockerfile chỉ COPY `app`) | Thêm khi sửa Dockerfile ở T0.6 |
| 2026-10-13 | T0.3             | `turbo test` cảnh báo "no output files" cho api vì `outputs: coverage/**` chưa có coverage                                                                                                                                                                                                                                                                                             | Bỏ qua tới khi bật coverage (T0.7)                                                                                       |
| 2026-10-13 | T0.3             | `pnpm-workspace.yaml`: thêm `allowBuilds: '@parcel/watcher': false` (postinstall chỉ là fallback, có binary dựng sẵn)                                                                                                                                                                                                                                                                  | Đã làm trong T0.3                                                                                                        |


| 2026-10-14 | T0.5 | Bước drift (`pnpm --filter contracts check:drift`) mới là lệnh chạy tay; CI chưa gọi nó | Nối vào GitHub Actions và `check:full` ở T0.7 |
| 2026-10-14 | T0.5 | `contracts` build CommonJS (khớp apps/api `node10`); chưa có app nào import. Khi web/api import, kiểm tra resolve và cân nhắc dual ESM/CJS nếu nâng Nest 12 | Xem lại khi T1.2 / T2.x lần đầu import `contracts` |
| 2026-10-14 | T0.5 | `generated.py` dùng `--strict-types` để pydantic không ép kiểu như Zod (chuỗi "1100000" không thành int); ngày ISO hai bên có thể lệch ở biên (datetime vs date) | Mở rộng fixture khi làm T2.7 |
| 2026-10-14 | T0.5 | Reviewer: `issueDate` ở Python là `date` (không strict), nhận cả `"2026-03-15T00:00:00"` và số nguyên `1773532800` trong khi Zod từ chối; JSON Schema có `pattern` nhưng pydantic bỏ qua. Cũng sinh hai lớp `Seller`/`Buyer` thay vì một `Party` | Xử lý ở T2.7: đặt `.meta({id})` cho Party, ép pattern cho ngày, thêm fixture |
| 2026-10-14 | T0.6 | `.env.example` ở gốc bị quyền ghi chặn nên agent không tạo được; Hậu đã tạo tay (agent không đọc được; Hậu tự đối chiếu với các biến `${...}` trong compose.yaml) | Đã xử lý; Hậu tự so nội dung khi đọc diff |
| 2026-10-14 | T0.6 | Reviewer: Keycloak dùng `POSTGRES_USER` (owner của DB `invoice`); RLS không áp dụng cho owner/superuser, nên app ở T1.3 không được kết nối bằng user này (cần role không phải owner hoặc `FORCE ROW LEVEL SECURITY`); cân nhắc role `keycloak` riêng trong init script | T1.3 (role app), T4.7 (production) |
| 2026-10-14 | T0.6 | Reviewer: image chưa ghim patch/digest (`pgvector:pg17`, `redis:8`, `keycloak:26.4`); secret mặc định `${VAR:-...}` nên đổi thành `${VAR:?}` ở production | T4.7 |
| 2026-10-14 | T0.6 | Reviewer: `check-arm64.mjs` coi manifest đơn kiến trúc là FAIL và gộp "không inspect được" với "thiếu arm64"; `01-init.sh` chèn `KEYCLOAK_DB` thẳng vào SQL | Bỏ qua tới khi có image/ tên DB khác (T4.7) |
| 2026-10-14 | T0.6 | Máy Hậu có Postgres (5432) và Redis (6379) chạy native trên Windows → compose map host port 5433/6380. `DATABASE_URL`/`REDIS_URL` ở T1.2/T1.3 phải dùng cổng này | T1.2, T1.3 |
| 2026-10-14 | T0.6 | `apps/api` chưa có `DATABASE_URL`, `REDIS_URL`, biến Keycloak (chưa có code dùng) | Thêm vào `apps/api/.env.example` + schema config ở T1.2/T1.3 |
| 2026-10-14 | T0.6 | Hook `guard.mjs` chặn `DROP TABLE`, nên bảng thử `persist_probe` còn trong DB dev (volume `pgdata`) | Hậu xoá tay (`! docker compose exec postgres psql -U invoice -d invoice -c "DROP TABLE persist_probe"`) hoặc `docker compose down -v` |
| 2026-10-14 | T0.6 | Healthcheck/`.dockerignore` của `apps/ai` chưa làm (T0.6 chưa đưa app vào compose) | Khi app vào compose (T4.7) |
| 2026-10-14 | T0.6 | Init script Postgres chỉ chạy khi volume `pgdata` trống (sửa script phải `down -v`); Keycloak dùng chung container Postgres với DB `keycloak` | Ghi vào runbook dev (T0.9) |
| 2026-10-15 | T0.7 | Spec ghi Vitest cho web/api/contracts nhưng api và contracts chạy Jest (Nest 11 CommonJS, T0.3). Hậu chốt: Vitest chỉ cho `apps/web`, giữ Jest ở api/contracts; đã sửa dòng trong `M0.md` | Hợp nhất runner khi nâng Nest 12 (dòng T0.3) |
| 2026-10-15 | T0.7 | Action GitHub chính chủ (`checkout`, `setup-node`) ghim theo tag major (`@v7`); `setup-uv` đã ghim SHA sau cảnh báo SonarCloud S7637; chưa có Dependabot cho workflow | T7.4 |
| 2026-10-15 | T0.7 | `check:full` hiện = `check:fast` + build + drift + secrets; chưa có integration/e2e/quét phụ thuộc vì chưa có test loại đó | Nối thêm ở T1.8, T2.10, T7.4 |
| 2026-10-15 | T0.7 | `check:secrets` (gitleaks qua `docker run`) quét lịch sử git (commit), không quét file chưa commit; cần Docker đang chạy | Chấp nhận; xem lại nếu thêm pre-commit hook |
| 2026-10-15 | T0.7 | Job `node` trong CI chạy `--filter='!ai'`, job `python` gọi lệnh `uv` trực tiếp (không qua `apps/ai/package.json`): thêm script mới ở `apps/ai/package.json` thì CI không tự chạy | Nhớ cập nhật cả hai khi đổi lệnh Python |
| 2026-10-15 | T0.7 | `vitest` kéo `lightningcss` (MPL-2.0, trong allow-list); đã kiểm licence 23 gói mới, không có gói ngoài allow-list | Xong |
| 2026-10-15 | T0.7 | SonarCloud (GitHub App ngoài kế hoạch, Hậu gắn vào repo) tự quét PR và có Quality Gate chặn ở Security Rating A; lần đầu báo C vì 12 cảnh báo ở `ci.yml` và `check-secrets.mjs` (SHA pin, `uv --frozen --no-build`). Đã sửa trong T0.7; script Node `check-secrets.mjs` bị Sonar báo thêm 3 lỗi taint nên thay bằng `docker run` thẳng trong `package.json`/CI. Chưa ghi vào ARCHITECTURE/ADR; chưa rõ có bật branch protection bắt buộc Gate | Hậu quyết giữ hay gỡ SonarCloud; nếu giữ, ghi 1 dòng vào ARCHITECTURE. Mỗi lần đổi workflow/script, xem Sonar API trước khi coi là xong |
| 2026-10-15 | T0.7 | CI chạy lại đủ 4 job + SonarCloud cho cả commit chỉ đổi docs, gây nhiễu. Giữ nguyên `ci.yml` ở T0.7 (chi phí 0đ, ~35s/lần). Hướng đề xuất ở T0.8: dùng bộ lọc đường dẫn theo **job** (docs-only chạy job kiểm tra docs/link/i18n/ADR, bỏ `node`, `python`, `schema-drift`) kèm một job cổng luôn chạy; chỉ đặt job cổng làm check bắt buộc khi bật branch protection (workflow bị lọc sẽ để check ở trạng thái pending và chặn merge). Đối chiếu tài liệu GitHub về draft PR và `[skip ci]` trước khi làm | Xếp lịch cùng T0.8. Từ giờ: gom commit docs/note vào commit cuối của task, chạy `pnpm check:fast` trước khi push, mở PR dạng Draft |
| 2026-10-16 | T0.7 | Hook `.claude/hooks/guard.mjs` báo nhầm: regex chặn force push (`\bgit\s+push\b.*\s(--force|-f)`) dùng `.*` nên khớp cả `--force` của `git worktree remove` khi nằm sau `git push` trong cùng một dòng lệnh (ví dụ nối bằng `;` hoặc `&&`). Tách thành các lệnh riêng thì qua | Siết regex (không vượt qua `;`, `&&`, `\|`) và thêm test trong `guard.test.mjs`; xếp cùng T0.9 |
| 2026-10-16 | T0.7 | Image gitleaks ghim theo tag `v8.30.0`, chưa theo digest (log CI hiện `sha256:691af3c7…`); tag có thể bị di chuyển | T7.4, cùng việc ghim SHA cho `checkout`/`setup-node` |
| 2026-10-16 | T0.7 | `turbo` cảnh báo "no output files found for task web#test" vì `turbo.json` khai báo `coverage/**` mà web chưa có coverage (cùng loại với dòng T0.3 cho api) | Bỏ qua tới khi bật coverage (sau M1) |
| 2026-10-16 | T0.8 | `check:i18n` đang SKIP vì chưa có `apps/web/messages`; script tự chuyển sang nghiêm (exit 1 nếu thiếu file) khi `apps/web/package.json` có `next-intl`. Giới hạn: không so sánh tham số lồng trong nhánh plural/select | Task i18n của M1 (cài next-intl) phải chạy `pnpm check:i18n` và dán output thật |
| 2026-10-16 | T0.8 | `check:links` chỉ kiểm link inline `[x](path)`; không kiểm link kiểu reference `[x][id]` và `<a href>`; không kiểm `http(s)` (tránh gọi mạng) | Chấp nhận; mở rộng nếu docs bắt đầu dùng reference-style |
| 2026-10-17 | T0.9 | Root chưa có script `pnpm dev` (không có task `dev` trong `turbo.json`); CLAUDE.md đã ghi lệnh dev từng app. Thêm task `dev` persistent + script gốc cần bạn quyết (chạy cả 3 app cùng lúc khi api/ai thiếu biến môi trường có thể lỗi). Các nơi còn nói `pnpm dev` chạy được: `compose.yaml:1`, `docs/plan/milestones/M0.md:5`, `docs/architecture/ARCHITECTURE.md:146`, `docs/setup/WSL2.md:71`; nếu không thêm script thì sửa các chỗ này | Chờ bạn quyết (thay cho dòng T0.1 cũ về task `dev`) |
| 2026-10-17 | T0.9 | `node --test .claude/hooks/guard.test.mjs` chưa nằm trong `check:full` hay CI, nên hook hỏng sẽ không bị cổng nào bắt | Chờ xếp lịch (cân nhắc gộp vào `test:scripts`) |
| 2026-10-17 | T0.9 | Hook `guard.mjs` chặn cả lệnh Bash chỉ vì chuỗi tên file env xuất hiện trong lệnh (kể cả heredoc sửa file khác, đã gặp khi làm T0.9), nên phải tách lệnh hoặc dùng Edit. Cùng nhóm với dòng T0.7 về regex force-push; bạn đã duyệt để ngoài T0.9 | Chờ xếp lịch cùng dòng T0.7 |
| 2026-10-17 | T1.1 | Keycloak 26.4: scope `organization` thường chỉ phát claim cho user thuộc đúng 1 organization; user thuộc nhiều tenant (`consultant@demo.example`) phải xin `organization:*` (cả hai tenant) hoặc `organization:<alias>` (một tenant). Đã kiểm bằng token thật | T1.5 phải xin scope `openid organization:*` khi đăng nhập; T1.2 coi token thiếu claim `organization` là bị từ chối (không có tenant); T1.7 chọn tenant bằng `organization:<alias>` hoặc kiểm membership phía API |
| 2026-10-17 | T1.1 | Claim `organization` là danh sách alias (`["acme"]`), không có id. T1.3 dùng `tenant_id uuid`. Realm đã đặt UUID cố định cho acme (`00000000-0000-4000-8000-0000000000a1`) và globex (`...a2`) | T1.3: bảng `tenants` có cột `alias` unique, seed đúng hai UUID này; T1.2 tra alias → tenant id |
| 2026-10-17 | T1.1 | Role là realm role, không theo organization: user thuộc 2 tenant có cùng role ở cả hai | T1.4: chấp nhận cho MVP, ghi vào ma trận quyền; đổi sang role theo tenant (membership trong DB) nếu cần |
| 2026-10-17 | T1.1 | Client `dev-cli` (password grant, mật khẩu demo `demo-dev-only`, `WEB_CLIENT_SECRET` mặc định) chỉ dành cho dev; `start-dev`, `sslRequired: external`, redirect URI `localhost` | T4.7: xóa `dev-cli`, đổi mật khẩu/secret, cập nhật redirect URI, bật chế độ production |
| 2026-10-17 | T1.1 | Issuer của token là `http://localhost:8080/realms/invoice` vì `start-dev` suy ra từ host của request; API trong Docker/VM sẽ thấy issuer khác | T1.2: cấu hình issuer tường minh qua env; T4.7: đặt `KC_HOSTNAME` |
| 2026-10-17 | T1.2 | Token thật của Keycloak 26.4 không có `sub` vì client `web`/`dev-cli` thiếu client scope `basic` (T1.1 bỏ sót; test dùng token tự ký nên không bắt được). Đã thêm `basic` vào `defaultClientScopes` của hai client trong realm JSON và kiểm bằng token thật | T1.5: client web đã có `basic`; realm import lại (`down -v`) để khớp file |
| 2026-10-17 | T1.2 | API từ chối (403) token có 0, nhiều hoặc alias lạ trong `organization`; tenantId hiện tra từ bảng tĩnh `tenant-directory.ts` | T1.3: thay bảng tĩnh bằng bảng `tenants`; T1.7: user nhiều tenant phải chọn tenant lúc đăng nhập (`organization:<alias>`), nếu không sẽ nhận 403; T1.4: `AuthUser.roles` đã có, chỉ cần thêm `@RequirePermission` |
| 2026-10-17 | T1.2 | `OIDC_ISSUER_URL` là biến bắt buộc của API (không có mặc định); JWKS mặc định `<issuer>/protocol/openid-connect/certs`, đặt `OIDC_JWKS_URL` khi API gọi Keycloak bằng host khác | T4.7/compose: đặt cả hai biến cho api container; `KC_HOSTNAME` ở production |
| 2026-10-17 | T1.2 | Khi Keycloak không với tới được lúc `jose` tải lại JWKS (timeout, mạng), guard hiện trả 401; client sẽ tưởng token sai. Key bị gỡ vẫn verify được từ cache tối đa 10 phút (`cacheMaxAge`), cooldown 30 giây có thể gây 401 tạm cho `kid` mới | Task xử lý lỗi/độ bền sau M1 (hoặc T4.7): phân biệt lỗi JWKS không với tới được (503) với token sai (401); cân nhắc rút ngắn `cacheMaxAge` ở production |
| 2026-10-17 | T1.3 | Tạo user/membership lười khi đăng nhập lần đầu + audit "login" (DATA_MODEL:36, SECURITY §5) không nằm trong spec T1.3; T1.7 cần `memberships` có dữ liệu để kiểm tra tenant được chọn | T1.7 (hoặc task riêng trước T1.7): provisioning lười; policy `users` đã cho phép INSERT |
| 2026-10-17 | T1.3 | Interceptor giữ một transaction/connection suốt request. Request dài (upload, gọi AI) có thể làm cạn pool | T2.3, T2.9: việc dài dùng `TenantDbService.run` ngắn, không giữ tx cả request |
| 2026-10-17 | T1.3 | CI chưa có Postgres: test RLS tích hợp (`pnpm --filter api test:int`) chỉ chạy tay với `pnpm infra:up` + `db:migrate` + `db:seed`. Spec workflow ghi Vitest+Testcontainers nhưng api dùng Jest (dòng T0.7) | T1.8: chuyển sang Testcontainers (image `pgvector/pgvector:pg17`), dùng lại `runMigrations`, nối vào CI và `check:full` |
| 2026-10-17 | T1.3 | `pg_dump` không chứa role. Migration tạo role `invoice_app` idempotent, nhưng restore vào DB trống phải tạo role trước (hoặc chạy `runMigrations` rồi nạp dữ liệu). Image production phải COPY thư mục `apps/api/drizzle/` | T7.5 (backup/restore, bước migration riêng, expand/contract), T4.7 (Dockerfile api) |
| 2026-10-17 | T1.3 | Owner DB hiện là superuser + BYPASSRLS (kiểm bằng `pg_roles`); production cần owner không phải superuser, mật khẩu riêng cho `invoice_app`, và seed demo dùng đường owner | T4.7, T7.6 |
| 2026-10-17 | T1.3 | `DEMO_READ_ONLY=true` có thể thêm `SET TRANSACTION READ ONLY` trong interceptor làm lớp phòng thủ thứ hai bên cạnh guard chặn non-GET (SECURITY §3); không làm ở T1.3 vì provisioning lười (ghi) sẽ bị chặn | T4.7 |
| 2026-10-17 | T1.3 | Drizzle (0.45) không sinh `FORCE ROW LEVEL SECURITY` (đã grep mã nguồn), nên RLS nằm trong migration SQL viết tay. Bảng mới ở M2+ phải tự thêm ENABLE/FORCE/policy/GRANT; test meta-catalog sẽ đỏ nếu quên | T2.2, T5.2, M6 notifications: dùng mẫu trong `0001_rls.sql` |
| 2026-10-17 | T1.3 | Image test cần extension `vector` (hiện chỉ tạo bởi init script lần đầu) và sẽ cần cho bảng `chunks` | T5.2: migration tự `CREATE EXTENSION IF NOT EXISTS vector` (owner), kiểm trên Testcontainers |
| 2026-10-17 | T1.3 | Sau T1.3 API cần `db:migrate` + `db:seed` (và `DATABASE_URL`) trước khi chạy, nếu không mọi token đều 403 "Unknown tenant"; mọi `sub` phải là uuid (token Keycloak thật đã đúng) | T1.5/T1.7, T4.7 (compose chạy migrate như bước riêng), runbook dev ở M8 |
| 2026-10-17 | T1.3 | Hook `guard.mjs` lại chặn nhầm heredoc có tên file env (dòng T0.9) và chặn lệnh xoá database (đúng thiết kế); DB/role tạm đã được Hậu xoá | Sửa regex hook cùng dòng T0.7/T0.9 |
| 2026-10-17 | T1.3 | Reviewer: mỗi request thêm một truy vấn tra alias → tenant (không cache) và một connection thứ hai cho transaction tenant; DB chập chờn làm mọi request 503 | Task độ bền/hiệu năng sau M1 (hoặc T6.6 k6): cache TTL ngắn alias → id |
| 2026-10-17 | T1.3 | Reviewer: interceptor gói `lastValueFrom(next.handle())` nên handler trả stream/SSE (Q&A có trích dẫn) chỉ phát giá trị cuối; `statement_timeout` 15 giây áp cho mọi transaction | T5.4/T6.x: handler stream mở transaction bằng `TenantDbService.run` thay vì dựa vào interceptor (hoặc thêm decorator bỏ qua); `SET LOCAL statement_timeout` theo từng `run` khi có việc dài |
| 2026-10-17 | T1.3 | Reviewer: policy `users_insert WITH CHECK (true)` cho phép tenant A thăm dò sự tồn tại của một `sub` qua lỗi trùng khoá | T1.7: khi làm provisioning, ràng buộc `id` = user đang đăng nhập hoặc đưa việc tạo user sang đường có đặc quyền |
| 2026-10-17 | T1.3 | Readiness dùng `Promise.race` nên `SELECT 1` không bị huỷ; số truy vấn chờ bị chặn bởi `connectionTimeoutMillis` 5 giây của pool và `statement_timeout` 15 giây | T7.x (observability): đo thử; nếu cần, probe dùng client riêng |
| 2026-10-18 | T1.4 | API.md ghi `/me` (kèm tenants, roles, permissions) nhưng code là `/auth/me` và chưa trả danh sách tenant; `permissions` đã có | T1.7: chốt đường dẫn (đổi API.md hoặc thêm route `/me`) và thêm danh sách tenant khi làm chọn tenant |
| 2026-10-18 | T1.4 | Ma trận trong `permissions.ts` và bảng ở SECURITY.md §3 được giữ đồng bộ bằng tay (test dùng bảng kỳ vọng viết riêng, không đọc SECURITY.md) | Cân nhắc script nhỏ so sánh hai nơi; reviewer kiểm tay mỗi khi đổi ma trận |
| 2026-10-18 | T1.4 | Từ giờ mọi controller mới phải có `@RequirePermission`, `@AnyAuthenticated` hoặc `@Public`, nếu không mọi request 403 `FORBIDDEN_UNDECLARED` | M2+ (mọi endpoint nghiệp vụ), `/notifications` dùng `@AnyAuthenticated` |
| 2026-10-18 | T1.4 | Guard `DEMO_READ_ONLY` (non-GET → 403 `DEMO_READ_ONLY`) chưa có; filter chỉ cho phép các `code` nằm trong whitelist `KNOWN_CODES` | M4 (ADR 0018): thêm code `DEMO_READ_ONLY` vào whitelist |
| 2026-10-18 | T1.4 | Route quên khai báo chính sách chỉ bị phát hiện khi có request gọi tới (403 `FORBIDDEN_UNDECLARED`); chưa có kiểm tra lúc khởi động hay test duyệt toàn bộ route của `AppModule`. Reviewer còn nêu: metadata key là chuỗi trần, `KNOWN_CODES` khai báo riêng khỏi guard | T1.8 hoặc M2: test duyệt route (Nest `DiscoveryService`) buộc mọi handler có một trong ba decorator; gom mã lỗi thành hằng chung khi thêm `DEMO_READ_ONLY` (M4) |
| 2026-10-18 | T1.5 | Ghi chú T1.1 nói web xin `organization:*`, nhưng T1.2 từ chối token nhiều tenant (403). T1.5 xin `organization` mặc định và `organization:<alias>` khi có `?tenant=`; spec T1.7 ("API nhận tenant đã chọn, kiểm membership") mâu thuẫn với T1.2 (tenant lấy từ claim duy nhất) | T1.7: chọn tenant = đăng nhập lại với `organization:<alias>`, hoặc đổi T1.2 để nhận tenant chọn; cần quyết định trước khi plan T1.7 |
| 2026-10-18 | T1.5 | Auth.js stable hiện là `next-auth` 4.24.15 (ISC); v5 vẫn beta. ADR 0006 ghi "stable major" nên dùng v4 | T1.5 (ghi trong plan); xem lại khi v5 stable |
| 2026-10-18 | T1.5 | T1.5 để pages ở `app/` (chưa có `[locale]`); T1.6 phải chuyển `login`/`dashboard`, `proxy.ts` matcher, `callbackUrl` và `pages.signIn` sang tiền tố locale | T1.6 |
| 2026-10-18 | T1.5 | Xoay refresh token cần `revokeRefreshToken: true` trong realm (hiện chưa bật); T1.5 sửa `realm-invoice.json` (đổi realm → `down -v` import lại) | T1.5 |
| 2026-10-18 | T1.5 | Endpoint cấp token ngắn hạn cho Socket.IO (ADR 0006) chưa làm; T1.5 chỉ cung cấp `getAccessToken()` phía server | T6.4 |
| 2026-10-18 | T1.5 | Đã kiểm với Keycloak 26.4 thật: user nhiều tenant đăng nhập không kèm `?tenant=` vẫn nhận màn "Select an organization" của Keycloak (acme/globex) trước bước mật khẩu, nên token ra một tenant. Đăng nhập là 2 bước (username rồi mật khẩu) do Organizations | T1.7: có thể đổi tenant bằng đăng nhập lại; T1.8 (Playwright) phải đi đủ 2 bước và màn chọn organization |
| 2026-10-18 | T1.5 | Session là JWT không trạng thái trong cookie: cookie cũ được replay sau logout vẫn dùng được đến khi access token hết hạn (≤5 phút), sau đó refresh thất bại. Single-flight chỉ đúng cho 1 instance Next.js | M8 (triển khai nhiều instance → lưu phiên phía server hoặc sticky), T7 security review |
| 2026-10-18 | T1.5 | Cookie session ~4.7KB, next-auth tự chia 2 mảnh; proxy tự chia lại (`auth/cookie.ts`). Thêm claim/role vào token làm cookie to hơn (giới hạn trình duyệt ~4KB mỗi cookie) | Mọi task thêm claim vào token Keycloak |
| 2026-10-18 | T1.5 | 5 biến web chưa có trong file mẫu env (hook chặn agent sửa) và `getAccessToken()` chưa có test/nơi dùng | Hậu thêm tay vào file mẫu env; T1.7 là người dùng đầu tiên của `getAccessToken()` |
| 2026-10-18 | T1.5 | Code-review còn lại chưa sửa: `/api/auth/signout` mặc định của next-auth chỉ xoá cookie local, không kết thúc phiên Keycloak (UI không link tới nó); redirect của `proxy.ts` mất query string và trả 307 cho request không phải GET; `KEYCLOAK_ISSUER` dùng chung cho gọi server-to-server và redirect trình duyệt | Chặn `/api/auth/signout` + sửa redirect: T1.7/T1.8; tách issuer nội bộ/công khai: M8 |
