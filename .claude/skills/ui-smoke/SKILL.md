---
name: ui-smoke
description: Chạy kịch bản kiểm thử giao diện bằng Chrome thật cho app shell (menu theo quyền, đổi tenant, đổi ngôn ngữ). Dùng khi muốn kiểm tay bằng trình duyệt một task web, không thay cho e2e Playwright của T1.8.
---
Giao việc cho subagent `browser-tester` (Agent tool, `subagent_type: "browser-tester"`) với kịch bản dưới đây. Điều kiện: infra, API (:3001) và web (:3000) đang chạy, extension Claude in Chrome đã bật. Nếu thiếu một trong hai, nói rõ cho người dùng thay vì thử lại.

Tài khoản và mật khẩu: xem `docs/setup/DEMO_ACCOUNTS.md`. Đăng xuất giữa các tài khoản.

## Kịch bản app shell (T1.7)

| # | Tài khoản | Làm gì | Kỳ vọng |
|---|---|---|---|
| 1 | `viewer@globex.example` | Mở `/vi/login`, đăng nhập | Vào `/vi/dashboard`; sidebar chỉ có Tài liệu, Hỏi đáp, Thống kê (`nav-documents`, `nav-ask`, `nav-insights`); không có `nav-upload`, `nav-members`; `data-testid="tenant"` là `globex`; không có dropdown đổi tổ chức |
| 2 | `viewer@globex.example` | Gõ tay `/vi/settings/members` | Trang 404 đã dịch (không phải trang trắng); đó là trang chưa có, không phải bằng chứng quyền (quyền do API chặn) |
| 3 | `accountant@acme.example` | Đăng nhập | Thêm `nav-upload`; vẫn không có `nav-members` |
| 4 | `admin@acme.example` | Đăng nhập | Đủ 5 mục menu; tenant `acme` |
| 5 | `consultant@demo.example` | Đăng nhập | Có `tenant-switcher` với `acme` và `globex` |
| 6 | `consultant@demo.example` | Chọn `globex` trong `tenant-switcher` | Trang tải lại; `dashboard-tenant` = `globex`; `dashboard-tenant-id` đổi từ `…0a1` sang `…0a2` |
| 7 | bất kỳ | Bấm bộ chuyển ngôn ngữ | URL đổi `/vi/…` ↔ `/en/…`, chữ menu đổi theo; tenant đã chọn giữ nguyên |
| 8 | bất kỳ | Bấm nút bật/tắt giao diện tối | Giao diện đổi và còn giữ sau khi tải lại |
| 9 | bất kỳ | Thu cửa sổ về ~375px | Sidebar ẩn, nút menu mở danh sách; bấm một mục hoặc nhấn Escape thì menu đóng; không có thanh cuộn ngang |
| 10 | bất kỳ | Bấm Đăng xuất | Về trang đăng nhập; mở `/vi/dashboard` bị chuyển về đăng nhập |

Báo cáo: bảng bước → đạt/không đạt → bằng chứng. Mọi bước không đạt kèm ảnh chụp và cách tái hiện.
