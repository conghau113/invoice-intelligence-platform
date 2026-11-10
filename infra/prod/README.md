# infra/prod: demo public chỉ-xem (T4.7)

Một VM Oracle Always Free A1 (arm64) chạy toàn bộ stack bằng Docker Compose sau Caddy (ADR 0010), ở chế độ `DEMO_READ_ONLY=true` (ADR 0018). Dựng máy từ đầu: `docs/setup/ORACLE.md`.

| File | Vai trò |
|---|---|
| `compose.prod.yaml` | Toàn bộ stack production. Image ghim phiên bản, mọi secret bắt buộc (`${VAR:?}`) |
| `Caddyfile` | HTTPS tự động, security headers, định tuyến `/` → web, `/auth/realms/*` + `/auth/resources/*` → Keycloak |
| `postgres-init/01-roles.sh` | Lần đầu: role owner không phải superuser, role + DB riêng cho Keycloak |
| `keycloak/realm-invoice.json` | Realm production, **sinh ra** từ realm dev bằng `keycloak/build-realm.mjs` (không sửa tay; `pnpm check:prod-realm` bắt lệch) |
| `scripts/demo-snapshot.mjs` | Export dữ liệu đã xử lý trên máy dev, import vào server |
| `compose.rehearsal.yaml` | Chỉ dùng khi diễn tập trên laptop |

## Ba lớp chặn ghi và lớp chặn LLM

1. `DemoReadOnlyGuard` (API, guard toàn cục đầu tiên): mọi method khác GET/HEAD/OPTIONS → `403 DEMO_READ_ONLY`, trước cả xác thực.
2. Transaction của tenant mở `READ ONLY`: lọt qua guard thì Postgres vẫn từ chối (SQLSTATE 25006).
3. Volume file mount `:ro` cho api và worker.

UI ẩn upload/duyệt/cài đặt vì `/auth/me` chỉ trả quyền đọc (tiện cho người dùng, không phải lớp bảo mật).

LLM: không có biến key nào, và `ai`/`worker` nằm trên mạng `backend` (`internal: true`) nên không có đường ra internet.

## Biến môi trường (`infra/prod/.env` trên server, `chmod 600`, không commit)

Sinh secret bằng `openssl rand -hex 32` (hex: an toàn khi nằm trong URL kết nối DB).

| Biến | Ý nghĩa |
|---|---|
| `DEMO_HOST` | Tên miền public, không có `https://` (vd. `ten.duckdns.org`). Diễn tập: `invoice.localhost` |
| `COMPOSE_PROFILES` | `duckdns` trên server (bật container cập nhật IP); bỏ trống khi diễn tập |
| `DUCKDNS_SUBDOMAIN`, `DUCKDNS_TOKEN` | Subdomain và token DuckDNS (chỉ server) |
| `POSTGRES_PASSWORD` | Superuser `postgres`: chỉ dùng cho init và import dữ liệu demo |
| `OWNER_DB_PASSWORD` | `invoice_owner`: chủ bảng, chạy migration |
| `APP_DB_PASSWORD` | `invoice_app`: role runtime của API/worker (RLS áp dụng) |
| `KEYCLOAK_DB_PASSWORD` | Role `keycloak` của DB `keycloak` |
| `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD` | Admin tạm lúc khởi động lần đầu (console không public) |
| `WEB_CLIENT_SECRET` | Secret client `web`, dùng chung giữa Keycloak và web |
| `DEMO_USER_PASSWORD` | Mật khẩu **công khai** của các tài khoản demo (T4.8 đăng lên README). Không dùng `demo-dev-only` |
| `NEXTAUTH_SECRET` | Mã hoá cookie phiên (≥ 32 ký tự) |
| `AI_SERVICE_TOKEN` | Token worker → AI (≥ 16 ký tự) |
| `DEMO_SNAPSHOT_DIR` | (tuỳ chọn) thư mục snapshot cho `demo-import`, mặc định `./snapshot` |

Cố ý không có: `GEMINI_API_KEY`, `LLM_*`.

## Chạy

```bash
cd infra/prod
docker compose -f compose.prod.yaml up -d --build --wait
docker compose -f compose.prod.yaml ps
```

Realm chỉ được import ở lần khởi động đầu (DB `keycloak` trống). Sau khi đổi `infra/keycloak/realm-invoice.json`: `node infra/prod/keycloak/build-realm.mjs`, rồi dựng lại DB Keycloak.

## Dữ liệu demo (xử lý sẵn trên máy dev)

Demo không gọi LLM, nên tài liệu được xử lý trên máy bạn (dev stack, Gemini free tier, chỉ dữ liệu tổng hợp; kiểm $0 trên trang billing như T4.4), rồi copy lên server.

1. Ghi lại thời điểm bắt đầu (`date -Iseconds`), rồi upload qua UI dev một lô từ `eval/datasets/v1/documents` (**không** dùng `injection-*`). Gợi ý cho `acme`: mỗi biến thể một file, `invoice-0000.pdf` (pdf-clean), `invoice-0001.pdf` (nhiều dòng), `invoice-0004.pdf` (nhiều trang), `invoice-0003.png`, `invoice-0019.png` (nhiễu), `invoice-0006.jpg` (nghiêng), `invoice-0014.jpg` (độ phân giải thấp), `invoice-0024.jpg` (EXIF xoay), cùng 4 file XML `invoice-0050.xml` đến `invoice-0053.xml`. Đăng nhập `viewer`/`consultant` để cho `globex` vài file XML.
2. Duyệt khoảng một nửa, sửa vài field trước khi duyệt (để trang Thống kê có tỉ lệ sửa), để phần còn lại ở `needs_review`.
3. Export (chỉ tài liệu tạo sau mốc thời gian, ở trạng thái đã xong, có file):
   ```bash
   cd apps/api
   SOURCE_DATABASE_URL=postgres://invoice:<mật khẩu dev>@localhost:5433/invoice \
   DATA_DIR=$PWD/../../data \
     node ../../infra/prod/scripts/demo-snapshot.mjs export ../../infra/prod/snapshot --since <thời điểm bước 1>
   ```
4. Copy `infra/prod/snapshot/` lên server (`scp -r`), rồi import một lần vào DB trống:
   ```bash
   docker compose -f compose.prod.yaml --profile tools run --rm demo-import
   ```
   Import kiểm hash từng file trước khi ghi, từ chối tenant không phải demo, và từ chối nếu tenant demo đã có tài liệu. Nếu chèn dữ liệu lỗi giữa chừng thì transaction rollback và các file vừa ghi bị xoá, nên sửa lỗi rồi chạy lại là an toàn.

## Diễn tập trên laptop (trước khi có VM)

Đặt các biến trong shell (không cần file env), `DEMO_HOST=invoice.localhost`, bỏ trống `COMPOSE_PROFILES`:

```bash
docker compose -f compose.prod.yaml up -d --build --wait
docker cp invoice-demo-caddy-1:/data/caddy/pki/authorities/local/root.crt /đường/dẫn/caddy-root.crt
REHEARSAL_CA=/đường/dẫn/caddy-root.crt docker compose -f compose.prod.yaml -f compose.rehearsal.yaml up -d --wait
```

Mở https://invoice.localhost (trình duyệt cảnh báo CA nội bộ, đây là bình thường khi diễn tập). Dọn: `docker compose -p invoice-demo down -v`.

## Kiểm chứng ("Xong khi" của T4.7)

```bash
# HTTPS + chứng chỉ Let's Encrypt
curl -sI https://$DEMO_HOST/vi/login | head -1
echo | openssl s_client -connect $DEMO_HOST:443 -servername $DEMO_HOST 2>/dev/null | openssl x509 -noout -issuer -dates
# Console admin, metrics, health của Keycloak không public (404)
curl -s -o /dev/null -w '%{http_code}\n' https://$DEMO_HOST/auth/admin/
# AI và worker không ra được internet, không có biến key LLM
docker compose -f compose.prod.yaml exec ai python -c "import urllib.request; urllib.request.urlopen('https://generativelanguage.googleapis.com/', timeout=8)"   # phải lỗi
docker compose -f compose.prod.yaml exec ai sh -c 'env | grep -iE "gemini|llm|api_key" || echo none'
docker compose -f compose.prod.yaml logs ai | grep -c 'POST /extract'   # 0
# RAM
docker stats --no-stream
free -m
```

POST bằng tài khoản demo → 403: đăng nhập trên trình duyệt, mở DevTools Console và chạy
`fetch('/api/documents/00000000-0000-4000-8000-000000000000/approve',{method:'POST',headers:{'if-match':'"1"','content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(console.log)`
→ `status: 403, code: "DEMO_READ_ONLY"`.
