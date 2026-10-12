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
