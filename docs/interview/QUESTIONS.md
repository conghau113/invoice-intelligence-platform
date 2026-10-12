# Ngân hàng câu hỏi trade-off (luyện ở T8.5)

Khung trả lời: **bối cảnh → các lựa chọn → tiêu chí → đánh đổi → quyết định → khi nào xem lại** (giống ADR).

| # | Câu hỏi | Nguồn để ôn |
|---|---|---|
| 1 | Monorepo hay polyrepo cho dự án này? | ADR 0001 |
| 2 | Vì sao tách dịch vụ AI bằng Python? Chi phí của quyết định đó? | ADR 0002 |
| 3 | Cách ly tenant: RLS, schema riêng hay DB riêng? | ADR 0003, T1.8 |
| 4 | Làm sao giữ schema đồng bộ giữa TypeScript và Python? | ADR 0004 |
| 5 | Một realm mỗi tenant hay Organizations trong Keycloak? | ADR 0005 |
| 6 | Token để ở đâu phía web? XSS vs CSRF? | ADR 0006 |
| 7 | Vì sao dùng hàng đợi? BullMQ vs RabbitMQ vs Kafka? | ADR 0008 |
| 8 | Chọn model LLM dựa trên tiêu chí nào? | ADR 0009, báo cáo T4.4 |
| 9 | Vì sao demo chạy Oracle Always Free trên một VM ARM? Rủi ro và phương án dự phòng? Khi nào cần managed/Kubernetes? | ADR 0010, setup/ORACLE.md |
| 10 | pgvector hay vector DB riêng? | ADR 0011 |
| 11 | Token bucket hay sliding window? Đặt rate limit ở đâu? | ADR 0012 |
| 12 | Cache gì, invalidate thế nào, quên tenant trong key thì sao? | ADR 0013 |
| 13 | WebSocket vs FCM vs SSE vs polling? | ADR 0014 |
| 14 | Trace đi qua hàng đợi thế nào? | ADR 0015, T7.1 |
| 15 | Prisma/TypeORM/Drizzle — vì sao Drizzle? | ADR 0016 |
| 16 | Đo độ chính xác AI thế nào, dữ liệu tổng hợp có giới hạn gì? | AI_PIPELINE §6 |
| 17 | Phòng prompt injection trực tiếp và gián tiếp thế nào? | SECURITY §6 |
| 18 | Vì sao không cho LLM viết SQL hay tự cộng số? | AI_PIPELINE §7 |
| 19 | Provider trả 429 thì hệ thống làm gì? | AI_PIPELINE §8, T6.2 |
| 20 | Migration thay đổi cột mà không downtime? | T7.5 |
| 21 | Bạn dùng AI viết code thế nào và làm sao chắc mình hiểu? | WORKFLOW, learning-log |
| 22 | Nếu làm lại, bạn đổi quyết định nào? | retrospective |
| 23 | Vì sao không dùng MinIO? Lưu file ra sao, khi nào chuyển sang S3? | ADR 0017 |
| 24 | Demo public của bạn tránh rủi ro pháp lý và điều khoản provider thế nào? | ADR 0018, LEGAL.md |
| 25 | Vì sao làm lát cắt xuyên suốt bằng XML trước khi tích hợp LLM? | M2, AI_PIPELINE §5 |
