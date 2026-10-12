# Demo public trên Oracle Cloud Always Free (task T4.7, runbook cho T7.5)

> Chi phí: 0đ. Bạn đã đồng ý xác minh thẻ khi đăng ký. **Không bấm "Upgrade to Pay As You Go"** nếu chưa bàn lại.
> Tài nguyên Always Free miễn phí "for the life of the account" nhưng chỉ ở **home region** (chọn lúc đăng ký, không đổi được). Năng lực máy free không được bảo đảm.

## 1. Đăng ký và tạo máy (bạn tự làm)
1. Đăng ký Oracle Cloud Free Tier, chọn home region gần Việt Nam (ví dụ Singapore). Xác minh thẻ.
2. Tạo VCN bằng wizard "VCN with Internet Connectivity".
3. Compute → Create instance: image **Ubuntu 24.04 (aarch64)**, shape **VM.Standard.A1.Flex, 2 OCPU, 12 GB**, gắn SSH public key của bạn, cấp public IPv4.
4. Báo lỗi "out of host capacity" → thử availability domain khác hoặc thử lại vào giờ khác. Sau 3 lần thất bại ở các thời điểm khác nhau → dùng phương án video (ghi vào TASKS.md).

## 2. Mạng và bảo mật
- Security List của subnet: thêm ingress TCP 80 và 443 từ 0.0.0.0/0. SSH (22) chỉ dùng key.
- Trên máy Ubuntu: ảnh Ubuntu của Oracle có sẵn luật iptables chặn cổng — mở 80/443 rồi lưu luật:
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```
  (Kiểm tra lại thứ tự luật bằng `sudo iptables -L INPUT --line-numbers` trước khi chèn.)
- `/etc/ssh/sshd_config`: `PasswordAuthentication no`; bật `unattended-upgrades`.

## 3. DuckDNS + Caddy
- Tạo subdomain trên duckdns.org, trỏ về public IP. Token DuckDNS chỉ để trong `.env` trên server.
- Caddy (container) cấp HTTPS tự động: `/` → web, `/api` → API, security headers.

## 4. Chạy ứng dụng
- Cài Docker Engine (repo chính thức của Docker cho Ubuntu arm64).
- `compose.prod.yaml` kéo image `linux/arm64` từ GHCR; `.env` server có `DEMO_READ_ONLY=true`, không có API key LLM.

## 5. Tránh bị thu hồi vì "idle"
Oracle có thể thu hồi máy Always Free nếu trong 7 ngày cả ba điều kiện đều đúng: CPU p95 < 20%, mạng < 20%, RAM < 20% (riêng A1). Stack đầy đủ dùng ~25% RAM → không thỏa điều kiện RAM. T7.5 thêm kiểm tra hằng ngày: cảnh báo nếu RAM dùng < 22%.

## 6. Backup và dựng lại (RTO < 1 giờ)
- Hằng ngày: `pg_dump` → mã hóa bằng `age` → upload lên GitHub Release của repo (dữ liệu chỉ là dữ liệu tổng hợp). Khóa giải mã cất ngoài server.
- Dựng lại: tạo máy mới (mục 1–2) → cài Docker → copy `.env` → `docker compose -f compose.prod.yaml up -d` → khôi phục backup → cập nhật IP trên DuckDNS.
- Không dựng lại được → video demo + repo (README ghi rõ).
