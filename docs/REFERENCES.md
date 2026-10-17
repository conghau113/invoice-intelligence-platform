# Tài liệu tham khảo: dịch vụ và công cụ dự án đang dùng

> Danh sách các dịch vụ ngoài repo và công cụ tự chạy, kèm trang tra cứu chính thức. Nguồn: `.github/workflows/ci.yml`, `compose.yaml`, `docs/architecture/`, `docs/LEGAL.md`.
> Link tài liệu gốc được ghi theo địa chỉ đã biết, không kiểm tra tự động. Nếu link hỏng, sửa tại đây.

## Dịch vụ ngoài repo

| Dịch vụ | Dùng để làm gì | Link |
|---|---|---|
| GitHub (repo, Actions, PR) | Lưu code, chạy CI (`.github/workflows/ci.yml`) | https://github.com/conghau113/invoice-intelligence-platform |
| SonarCloud | GitHub App ngoài, tự quét PR; PR fail nếu Security Rating thấp hơn A (xem `docs/plan/WORKFLOW.md`) | https://sonarcloud.io |
| SonarCloud API | Đọc kết quả quét sau khi push | https://sonarcloud.io/api/qualitygates/project_status?projectKey=… · https://sonarcloud.io/api/issues/search?componentKeys=… |
| Gemini API (gói Unpaid) | LLM cho `eval/` và dev; CI dùng fake provider (ADR 0009, `docs/LEGAL.md`) | https://ai.google.dev/gemini-api/docs |
| Oracle Cloud Always Free | VM chạy demo công khai, từ M4 (ADR 0010) | https://www.oracle.com/cloud/free/ |
| DuckDNS | Tên miền con cho demo | https://www.duckdns.org |
| GHCR | Chứa image Docker cho demo | https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry |

## Phần mềm tự chạy (Docker, CI) và thư viện chính

| Công cụ | Vai trò | Link |
|---|---|---|
| Keycloak 26.4 | Đăng nhập OIDC, Organizations làm tenant (ADR 0005) | https://www.keycloak.org/docs/latest/server_admin/ |
| `jose` | Kiểm tra JWT/JWKS trong API (T1.2) | https://github.com/panva/jose |
| PostgreSQL + pgvector (`pgvector/pgvector:pg17`) | CSDL, RLS, vector search (ADR 0003, 0011) | https://github.com/pgvector/pgvector |
| Redis 8 | Hàng đợi, cache (ADR 0008, 0013) | https://redis.io/docs/ |
| Gitleaks v8.30.0 | Quét lộ bí mật (`pnpm check:secrets`, CI) | https://github.com/gitleaks/gitleaks |
| Caddy | HTTPS tự động cho demo | https://caddyserver.com/docs/ |
| pnpm | Quản lý package, workspace | https://pnpm.io |
| Turborepo | Chạy task trong monorepo | https://turborepo.com/docs |
| uv | Quản lý môi trường Python cho `apps/ai` | https://docs.astral.sh/uv/ |

## Khi thêm dịch vụ hoặc công cụ mới

Thêm một dòng vào bảng trên cùng lúc với task đưa nó vào. Dịch vụ trả phí hoặc giấy phép chưa nằm trong allow-list cần Hậu duyệt trước (xem `CLAUDE.md` và `docs/LEGAL.md`).
