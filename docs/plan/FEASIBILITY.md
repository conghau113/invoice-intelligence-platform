# Đánh giá tính khả thi của kế hoạch (v2)

> Cập nhật: 12/10/2026. Mỗi kết luận ghi căn cứ và mức tin cậy. Nguồn ở cuối file.
> Mức tin cậy: **Cao** = tài liệu chính thức/dữ liệu đo trực tiếp · **Vừa** = nguồn thứ cấp đáng tin hoặc mẫu nhỏ · **Thấp** = ước tính của tôi.
> Đây không phải tư vấn pháp lý.

## 1. Kết luận nhanh

| Câu hỏi | Kết luận | Tin cậy |
|---|---|---|
| Làm xong được với 1 người + Claude Code Pro + Cursor Pro? | **Được**, với phạm vi đã cắt (không micro-frontend/Kafka/K8s). Rủi ro lớn nhất: quota Claude, cấu hình hạ tầng (Keycloak, OTel), Oracle không cấp máy free. | Vừa |
| Bao lâu? | ~243 giờ ≈ 41 ngày làm việc (dự kiến), 32–57 ngày (lạc quan–thận trọng). Tới điểm nộp hồ sơ (M4): ~25 ngày (20–35). | Thấp → hiệu chỉnh sau M1 |
| Chi phí tiền? | **0đ**: chạy local; demo trên Oracle Always Free (chỉ xác minh thẻ khi đăng ký); DuckDNS; GitHub Actions miễn phí cho repo public; Gemini free tier không bật billing; Grafana Cloud free. | Vừa (điều kiện free có thể đổi) |
| Máy của bạn đủ không? | Đủ: 24 GB RAM, 4 nhân/8 luồng; stack ~3–4 GB + dev server. WSL2 mặc định dùng tối đa 50% RAM (~12 GB). | Vừa |
| An toàn pháp lý? | Có, với các ràng buộc: chỉ dữ liệu tổng hợp; demo chỉ-xem, không upload, không gọi LLM; giấy phép thư viện kiểm tra trong CI. | Vừa |
| Có "flex" được không? | Có, nếu có số đo thật + demo + giải thích được. Bằng chứng mới gây ấn tượng, không phải danh sách công nghệ. | Vừa |
| Học được thật không? | Có, nếu giữ cổng hiểu. Giao hết cho AI làm giảm điểm hiểu biết rõ rệt trong nghiên cứu Shen & Tamkin (2026, preprint, mẫu nhỏ). | Vừa |

## 2. Khả thi kỹ thuật (từng thành phần)

| Thành phần | Đánh giá | Căn cứ | Tin cậy |
|---|---|---|---|
| Phiên bản thư viện | Đều có bản ổn định: Next.js 16.4, next-intl 4.14, NestJS 12.1, Zod 4.6, RHF 7.89, TanStack Query 5.104, BullMQ 6.3, Drizzle 0.45, FastAPI 0.143, pydantic 2.14 | npm/PyPI ngày 11/10/2026 | Cao |
| Claude Code trên Windows | Hỗ trợ WSL2 (cài bản Linux trong WSL) và Windows gốc; hook viết bằng Node chạy được cả hai | Tài liệu chính thức Claude Code (setup) | Cao |
| Cursor + WSL | Có extension WSL; diễn đàn có báo lỗi mất kết nối ở vài phiên bản → có cách dự phòng | Diễn đàn Cursor | Vừa |
| Keycloak | Demo cần ~0,5 vCPU, 768 MB–1 GB RAM | Skycloak sizing | Vừa |
| Keycloak Organizations | Có từ bản 25 (preview), mục tiêu supported ở 26 | Blog Keycloak | Vừa → kiểm ở T1.1 |
| pgvector | HNSW tối đa 2.000 chiều cho kiểu `vector` → dùng 768 chiều | pgvector; Gemini embedding hỗ trợ cắt chiều | Cao |
| Trích xuất bằng LLM | Benchmark công khai 03/2026 (20 hóa đơn): Gemini 3 Pro 94,75%, Azure DI 90,52%, GPT-5.2 ~88% | Blog nhà cung cấp, mẫu nhỏ | Vừa |
| Hóa đơn điện tử VN | Bắt buộc định dạng XML → parser xác định, làm trước trong lát cắt M2 | NĐ 123/2020 Điều 12 khoản 1 | Cao |
| Gemini free tier | Có ở Việt Nam, không cần billing; dữ liệu có thể dùng cải thiện sản phẩm và được người xem; không gửi thông tin cá nhân; app cho người dùng EEA/CH/UK phải dùng Paid | Gemini API Terms, Available regions | Cao |
| Provider dự phòng | Groq (30 RPM, 1.000 RPD, không train), OpenRouter free (20 RPM, 50 RPD) qua API chính thức; khả năng đọc ảnh cần kiểm ở T4.4 | OpenRouter blog 09/2026 | Vừa |
| 9Router | **Không dùng**: proxy chạy local, "free" chủ yếu nhờ tài khoản subscription của chính bạn hoặc free tier bên thứ ba; dùng gói Claude Pro qua công cụ bên thứ ba trái điều khoản Anthropic (02/2026); không có chính sách quyền riêng tư | README 9Router, Anthropic | Cao |
| Lưu file | `StoragePort` + filesystem local. MinIO community bị archive 25/04/2026 (không vá bảo mật); R2 cần thẻ; SeaweedFS (Apache 2.0) là tùy chọn | GitHub MinIO, AIStor Free Agreement, so sánh 04/2026 | Cao |
| Redis | Redis 8 (05/2025) có thêm AGPLv3; dùng nguyên bản như container riêng | Phoronix | Cao |
| Hosting demo | Oracle Always Free A1: 2 OCPU/12 GB (giảm từ 4/24 ngày 15/06/2026), miễn phí "for the life of the account" ở home region, có thể thu hồi máy idle (CPU p95, mạng, RAM đều < 20% trong 7 ngày), có thể hết máy free | Oracle docs, InfoQ 07/2026 | Cao |
| Azure | Free account cần thẻ ($200/30 ngày + VM 1 GB 12 tháng — không đủ); Azure for Students chỉ cho sinh viên toàn thời gian (bạn không đủ điều kiện) → chỉ là tùy chọn O2 | Azure | Cao |
| Tên miền | VPS không kèm tên miền; DuckDNS cho subdomain miễn phí, không cam kết uptime | DuckDNS | Vừa |
| CI | GitHub Actions miễn phí cho repo public với runner chuẩn | GitHub Docs | Cao |
| Observability | Grafana Cloud free: 50 GB trace, 50 GB log, 10k series, 14 ngày | costbench 07/2026 | Vừa → kiểm trước T7.1 |

## 3. Khả thi về thời gian & quota

- **Ước tính giờ** từng task do tôi đặt (Tin cậy: Thấp); hiệu chỉnh sau M1 theo ROADMAP §6.
- **METR 2026**: chưa kết luận được AI tăng hay giảm tốc độ dev có kinh nghiệm (khoảng tin cậy chứa 0) → không giả định AI làm nhanh gấp nhiều lần.
- **Quota Claude Code Pro**: không có con số công bố; Pro được nâng 5h-limit (05/2026, 09/2026) và +25% weekly (09/2026). 6 giờ tập trung/ngày có thể chạm trần → đo 3 ngày đầu. Đây là **rủi ro số 1** về timeline.

## 4. Khả thi về mục tiêu nghề nghiệp

- Stack Overflow 2026: 48% dev tin AI khi kết quả kiểm chứng được; chỉ 6,6% tin AI cho cả quyết định quan trọng → thị trường đánh giá cao người **kiểm chứng** được AI.
- JetBrains 2026: 90% dùng AI hằng tuần; Claude Code tăng từ 18% lên 39% → dùng agent không còn là điểm khác biệt; điểm khác biệt là hệ thống làm ra và độ sâu khi giải thích.
- Mục "How I used AI" và mục pháp lý/dữ liệu trong README cho thấy bạn làm việc có trách nhiệm với AI và dữ liệu.

## 5. Rủi ro & phương án

| # | Rủi ro | Khả năng | Ảnh hưởng | Phương án |
|---|---|---|---|---|
| R1 | Hết quota Claude giữa ngày | Cao | Trễ timeline | Việc nhỏ sang Cursor; Sonnet mặc định; đo `/usage`; nâng gói chỉ khi bạn quyết (tốn tiền) |
| R2 | Keycloak/Auth.js/Organizations cấu hình lâu | Vừa | Trễ M1 | Realm-as-code; kẹt 1h → hỏi chat; dự phòng realm-per-tenant (ADR 0005) |
| R3 | Gemini free tier đổi điều kiện/giới hạn | Vừa | Không chạy được eval | Provider interface; provider dự phòng qua API chính thức; fake provider cho dev |
| R4 | Oracle hết máy free hoặc thu hồi VM | Vừa | Mất link demo | Thử nhiều thời điểm; giữ RAM > 20%; hạ tầng là code + backup ngoài Oracle + runbook dựng lại < 1h; cuối cùng là video |
| R5 | Số đo eval quá đẹp do dữ liệu tổng hợp | Cao | Mất uy tín khi bị hỏi | Ghi rõ giới hạn; biến thể khó; số liệu người dùng sửa; không đặt ngưỡng trước baseline |
| R6 | "Vibe code" nhưng không hiểu | Vừa | Trượt phỏng vấn | Cổng hiểu bắt buộc, kiểm tra không AI cuối mốc, debug drill |
| R7 | Lan man phạm vi | Vừa | Không bao giờ xong | Mục "Ngoài phạm vi" ở mỗi task; "Phát sinh" trong TASKS.md |
| R8 | Docs lệch code theo thời gian | Cao | Docs vô giá trị | Bảng nguồn chính (WORKFLOW §1); cổng tự động; T8.2 rà khớp |
| R9 | Vi phạm pháp lý/điều khoản vô tình | Thấp | Uy tín, tài khoản | Chỉ dữ liệu tổng hợp; demo chỉ-xem, không LLM; kiểm tra giấy phép trong CI; LEGAL.md |
| R10 | Phát sinh chi phí ngoài ý muốn | Thấp | Tiền | Không bật billing, không nâng PAYG, rule trong CLAUDE.md buộc agent hỏi trước |
| R11 | Lỗi môi trường WSL/Docker/Cursor | Vừa | Trễ M0 | Hướng dẫn `docs/setup/WSL2.md`; dự phòng mở thư mục qua `\\wsl$` |

## 6. Còn chưa kiểm chứng (kiểm khi tới task)

- Keycloak Organizations ở bản cài thực tế (T1.1).
- Giới hạn free tier Gemini của tài khoản bạn (AI Studio, trước T3.1).
- Provider dự phòng có đọc ảnh và structured output không (T4.4).
- Cấu trúc XML của nhà cung cấp hóa đơn thật (chỉ hỗ trợ cấu trúc tổng hợp; ghi giới hạn ở T2.8).
- Oracle có cấp được máy A1 ở home region không; RAM thực tế (T4.7).
- Giới hạn Grafana Cloud free hiện hành (T7.1).

## Nguồn

- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- Claude Code setup (Windows/WSL): https://code.claude.com/docs/en/setup
- Martin Fowler / Böckeler, Spec-Driven Development tools (10/2025): https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- Claude usage limits (10/2026): https://promptslove.com/blog/claude-usage-limits/
- Anthropic cấm dùng subscription qua công cụ bên thứ ba (02/2026): https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block
- 9Router: https://github.com/decolua/9router · https://9router.com/
- Invoice extraction benchmark (03/2026): https://www.businesswaretech.com/blog/best-ai-models-for-invoice-processing-in-2026-gemini-aws-chatgpt
- Gemini API Terms: https://ai.google.dev/gemini-api/terms
- Gemini available regions: https://ai.google.dev/gemini-api/docs/available-regions
- Gemini billing: https://ai.google.dev/gemini-api/docs/billing
- Free LLM APIs compared (09/2026): https://openrouter.ai/blog/tutorials/free-llm-apis-compared/
- Gemini Embedding: https://developers.googleblog.com/en/gemini-embedding-available-gemini-api/
- Keycloak Organizations: https://www.keycloak.org/2024/06/announcement-keycloak-organizations
- Keycloak sizing: https://skycloak.io/blog/keycloak-production-sizing-ram-cpu-requirements/
- Oracle Always Free Resources: https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm
- InfoQ, Oracle halves Always Free A1 (07/2026): https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- Oracle Ubuntu firewall (iptables): https://techoverflow.net/2021/08/19/how-to-disable-instance-firewall-on-ubuntu-on-oracle-cloud/
- Azure free tier 2026: https://agentdeals.dev/azure-free-tier-2026 · Azure for Students: https://azure.microsoft.com/en-us/free/students/
- MinIO archived: https://github.com/minio/minio · AIStor Free: https://www.min.io/legal/aistor-free-agreement
- S3 alternatives (04/2026): https://blog.elest.io/rustfs-vs-seaweedfs-vs-garage-which-minio-alternative-should-you-pick/
- Redis 8 licensing: https://www.phoronix.com/news/Redis-8.0-Goes-AGPLv3 · BullMQ compatibility: https://docs.bullmq.io/guide/redis-tm-compatibility/
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Grafana Cloud free plan: https://costbench.com/software/observability/grafana-cloud/free-plan/
- ui-ux-pro-max LICENSE (MIT): https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/LICENSE
- Luật BVDLCN 91/2025/QH15: https://luatvietnam.vn/dan-su/nghi-dinh-huong-dan-luat-bao-ve-du-lieu-ca-nhan-2025-la-nghi-dinh-nao-568-103658-article.html
- NĐ 123/2020 Điều 12 (XML): https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/hoa-don-dien-tu-su-dung-ngon-ngu-dinh-dang-gi-221363-191342.html
- pgvector: https://github.com/pgvector/pgvector
- Phiên bản thư viện: npm registry và PyPI, tra ngày 11/10/2026
- Số liệu Stack Overflow 2026, JetBrains 2026, METR 2026, Shen & Tamkin 2026: đã kiểm chứng trong các phần trước của cuộc trò chuyện
