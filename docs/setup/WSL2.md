# Cài môi trường: Windows + WSL2 (task T0.0)

> Mục tiêu: code nằm trong Linux (WSL2) để Docker mount nhanh và môi trường giống server. Tất cả miễn phí.
> Máy tham chiếu: Windows, i7-8565U, 24 GB RAM, Docker Desktop đã cài.

## 1. WSL2 + Ubuntu
PowerShell (Run as Administrator):
```powershell
wsl --install -d Ubuntu-24.04
wsl --set-default-version 2
```
Khởi động lại máy nếu được yêu cầu, mở "Ubuntu" và tạo user Linux.

Mặc định WSL2 dùng tối đa 50% RAM (~12 GB) — đủ cho dự án. Nếu muốn cố định, tạo `C:\Users\<bạn>\.wslconfig`:
```ini
[wsl2]
memory=12GB
```
rồi chạy `wsl --shutdown`.

## 2. Docker Desktop dùng WSL2
Docker Desktop → Settings → General: bật "Use the WSL 2 based engine". Resources → WSL integration: bật cho Ubuntu-24.04.
Kiểm tra trong Ubuntu: `docker run --rm hello-world`.

## 3. Công cụ trong Ubuntu
```bash
sudo apt update && sudo apt install -y git build-essential unzip
# Node LTS qua fnm
curl -fsSL https://fnm.vercel.app/install | bash
exec $SHELL
fnm install --lts && fnm default lts-latest
# pnpm
npm install -g pnpm
# uv (Python)
curl -LsSf https://astral.sh/uv/install.sh | sh
# Claude Code (bản Linux chạy trong WSL)
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```
Lưu ý: Claude Code dùng gói Pro qua đăng nhập trình duyệt. **Không** đặt biến `ANTHROPIC_API_KEY` trong shell (Claude Code sẽ dùng key đó và tính tiền theo API).

## 4. Thư mục code
```bash
mkdir -p ~/code && cd ~/code
git clone https://github.com/<user>/<repo>.git
```
Không đặt code trong `/mnt/c/...` (chậm khi Docker mount và khi chạy pnpm).

## 5. Cursor với WSL
Cài Cursor trên Windows → cài extension WSL của Cursor → Command Palette "Connect to WSL" → mở `~/code/<repo>`.
Diễn đàn Cursor có báo lỗi mất kết nối WSL ở một số phiên bản; nếu gặp: cập nhật Cursor, hoặc tạm mở thư mục qua đường dẫn `\\wsl$\Ubuntu-24.04\home\<user>\code\<repo>`.

## 6. API key Gemini (miễn phí)
Tạo key ở Google AI Studio. **Không** liên kết billing (giữ free tier). Lưu vào `apps/ai/.env` (đã nằm trong `.gitignore`). Chỉ gửi dữ liệu tổng hợp.

## 7. Kiểm tra xong T0.0
```bash
docker run --rm hello-world && node -v && pnpm -v && uv --version && claude --version
```

---

## Phương án B: làm trực tiếp trên Windows (ổ E:), không dùng WSL

Dùng được, nhưng chấp nhận các đánh đổi sau:

| Vấn đề | Ảnh hưởng | Cách giảm |
|---|---|---|
| Docker bind-mount từ ổ Windows chậm hơn nhiều và container không nhận sự kiện thay đổi file (theo tài liệu Docker) | Hot reload trong container chậm/không chạy | Chỉ chạy **hạ tầng** (Postgres, Redis, Keycloak) trong Docker; chạy web/api/ai **trực tiếp trên Windows** bằng `pnpm dev` và `uv run` — không mount source vào container khi dev |
| Claude Code trên Windows gốc cần Git for Windows để có Bash tool; không hỗ trợ sandboxing | Một số lệnh shell khác Linux | Cài Git for Windows; hook đã viết bằng Node, cấu hình dạng exec nên chạy được |
| Script/shell trong repo viết cho Linux | Lệnh `.sh` không chạy trong PowerShell | Ưu tiên script Node (`.mjs`) cho mọi tiện ích của repo |
| Môi trường khác server (Linux ARM trên Oracle) | Lỗi chỉ xuất hiện khi deploy | CI chạy trên Linux; build image multi-arch trong CI |

Cài đặt cho phương án B (PowerShell):
```powershell
winget install Git.Git OpenJS.NodeJS.LTS astral-sh.uv
npm install -g pnpm
irm https://claude.ai/install.ps1 | iex
claude --version
```
Kiểm tra lại tên gói winget bằng `winget search <tên>` nếu lệnh báo không tìm thấy.

Repo đã có `.gitattributes` (`* text=auto eol=lf`) để tránh lỗi xuống dòng CRLF giữa Windows và Linux.
