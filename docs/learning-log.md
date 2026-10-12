# Learning log

Mỗi task 2–3 dòng. Đây là nguồn cho mục "How I used AI" trong README — ghi trung thực cả chỗ agent sai và chỗ mình chưa hiểu.

| Ngày | Task | Học được gì | Agent sai/đề xuất bị loại | Giờ thực tế |
|---|---|---|---|---|
| 2026-10-12 | T0.0 | WSL2 Ubuntu 24.04, code ở ~/code (filesystem Linux). Phiên bản: Node v24.21.0 (fnm), pnpm 12.11.2 (corepack, `pnpm@latest`), uv 0.13.0, Docker 28.5.1 (hello-world OK), Claude Code 2.1.296. pnpm ban đầu trỏ nhầm bản Windows /mnt/c (panic) → dùng corepack shim Linux đứng trước trong PATH. PATH duyệt trái sang phải; WSL tự nối PATH Windows; shim che bản Windows chứ không xóa (`which -a pnpm`). Code ở ~/code vì dữ liệu cần nằm trên filesystem Linux (I/O); việc dùng binary Linux là vấn đề riêng. Gemini API free tier: prompt/response có thể dùng để huấn luyện và có người đọc → chỉ gửi dữ liệu tổng hợp. Gemini key đã tạo (không billing), chưa đưa vào .env vì dự án chưa khởi tạo xong. | Agent đề xuất cài uv bằng lệnh pipe curl vào sh (đúng như WSL2.md) → hook chặn; đổi sang tải script về, đọc, rồi chạy. Cổng hiểu: Hậu nhầm Gemini Apps với Gemini API khi trả lời free/paid (đã kiểm tra điều khoản API). | |
