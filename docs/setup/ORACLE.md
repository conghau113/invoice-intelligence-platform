# Demo public trên Oracle Cloud Always Free (task T4.7, runbook cho T7.5)

> Chi phí: 0đ. Bạn đã đồng ý xác minh thẻ khi đăng ký. **Không bấm "Upgrade to Pay As You Go"** nếu chưa bàn lại.
> Tài nguyên Always Free miễn phí "for the life of the account" nhưng chỉ ở **home region** (chọn lúc đăng ký, không đổi được). Năng lực máy free không được bảo đảm.

Cấu hình chạy nằm ở `infra/prod/` (xem `infra/prod/README.md` cho lệnh vận hành và bảng biến môi trường). Tài liệu này là các bước dựng máy từ đầu.

## 1. Đăng ký và tạo máy (bạn tự làm)
1. Đăng ký Oracle Cloud Free Tier, chọn home region gần Việt Nam (ví dụ Singapore). Xác minh thẻ.
2. Tạo VCN bằng wizard "VCN with Internet Connectivity".
3. Compute → Create instance: image **Ubuntu 24.04 (aarch64)**, shape **VM.Standard.A1.Flex, 2 OCPU, 12 GB**, gắn SSH public key của bạn, cấp public IPv4. Boot volume mặc định (≤ 200 GB tổng là free).
4. Báo lỗi "out of host capacity" → thử availability domain khác hoặc thử lại vào giờ khác. Ghi mỗi lần thử (thời điểm, AD, kết quả) vào ghi chú T4.7 trong `docs/plan/TASKS.md`. Sau 3 lần thất bại ở các thời điểm khác nhau → dùng phương án video (ghi lý do vào TASKS.md).

## 2. Mạng và bảo mật
- **Security List** của subnet: thêm ingress TCP 80 và 443 từ `0.0.0.0/0`. Giữ ingress 22 (SSH). Không mở cổng nào khác (Postgres, Keycloak, API đều không publish ra host).
- **Firewall trên Ubuntu**: ảnh Ubuntu của Oracle có sẵn luật iptables chặn mọi cổng trừ 22. Xem thứ tự luật trước, rồi chèn 80/443 **trước** luật `REJECT` và lưu lại:
  ```bash
  sudo iptables -L INPUT --line-numbers          # tìm số dòng của luật REJECT
  sudo iptables -I INPUT <số dòng REJECT> -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo iptables -I INPUT <số dòng REJECT> -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo netfilter-persistent save
  ```
- **SSH chỉ bằng key**: tạo `/etc/ssh/sshd_config.d/99-hardening.conf` gồm `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`; kiểm bằng `sudo sshd -t` rồi `sudo systemctl reload ssh`. Mở một phiên SSH thứ hai để thử trước khi đóng phiên cũ.
- Cập nhật bảo mật tự động: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.

## 3. DuckDNS + Caddy
- Tạo subdomain trên duckdns.org, trỏ về public IP của máy. Token DuckDNS chỉ để trong `infra/prod/.env` trên server (`COMPOSE_PROFILES=duckdns` bật container cập nhật IP 30 phút một lần).
- Caddy (container) tự xin chứng chỉ Let's Encrypt cho `DEMO_HOST` qua cổng 80/443, thêm security headers. Đường đi: `/` → web (kể cả `/api/*` của web và next-auth), `/auth/realms/*`, `/auth/resources/*` → Keycloak. API Nest, worker, AI, Postgres, Redis nằm trên mạng Docker `internal` không có đường ra internet; console admin Keycloak không public.

## 4. Chạy ứng dụng
1. Cài Docker Engine từ repo chính thức của Docker cho Ubuntu arm64 (docs.docker.com/engine/install/ubuntu), thêm user vào nhóm `docker`.
2. `git clone` repo vào máy, `cd infra/prod`.
3. Tạo `infra/prod/.env` theo bảng biến trong `infra/prod/README.md` (`chmod 600`). `DEMO_READ_ONLY=true` đã ghi cứng trong compose; **không** có biến key LLM nào.
4. `docker compose -f compose.prod.yaml up -d --build --wait`. Image build ngay trên máy (arm64 gốc, không cần registry; CD qua GHCR là việc của T7.5). Lần đầu mất vài phút.
5. Nạp dữ liệu demo đã xử lý sẵn (mục "Dữ liệu demo" trong `infra/prod/README.md`).

## 5. Tránh bị thu hồi vì "idle"
Oracle có thể thu hồi máy Always Free nếu trong 7 ngày **cả ba** điều kiện đều đúng: CPU p95 < 20%, mạng < 20%, RAM < 20% (riêng A1). Demo chỉ-xem ít truy cập nên CPU và mạng gần như chắc chắn dưới 20%; RAM là điều kiện duy nhất giữ máy.

Đo thực tế (diễn tập T4.7, `docker stats`): cả stack khi rảnh chỉ dùng ~1,1 GB (≈ 9% của 12 GB), thấp hơn nhiều so với ước tính 25% trước đây. Vì vậy Keycloak chạy với heap cố định 2 GB, chạm trước toàn bộ khi khởi động (`JAVA_OPTS_KC_HEAP=-Xms2g -Xmx2g -XX:+AlwaysPreTouch`): heap cố định là cấu hình JVM production thường dùng, và đưa tổng container lên ~2,8 GB (≈ 23%), chưa tính hệ điều hành. Con số đo trên VM thật ghi trong learning-log T4.7. T7.5 thêm kiểm tra hằng ngày: cảnh báo nếu RAM dùng < 22%.

## 6. Backup và dựng lại (RTO < 1 giờ, T7.5)
- Hằng ngày: `pg_dump` → mã hóa bằng `age` → upload lên GitHub Release của repo (dữ liệu chỉ là dữ liệu tổng hợp). Khóa giải mã cất ngoài server.
- Dựng lại: tạo máy mới (mục 1–2) → cài Docker → copy `.env` → `docker compose -f compose.prod.yaml up -d --build --wait` → nạp lại snapshot demo hoặc khôi phục backup → cập nhật IP trên DuckDNS.
- Không dựng lại được → video demo + repo (README ghi rõ).
