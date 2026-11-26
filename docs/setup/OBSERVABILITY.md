# Tracing với Grafana Cloud (task T7.1)

> Theo ADR 0015: OpenTelemetry trong cả 4 dịch vụ, xuất OTLP sang Grafana Cloud bản free. Không tự host Grafana.

## Bật/tắt

Tracing **tắt** khi không có biến `OTEL_EXPORTER_OTLP_ENDPOINT`: test, CI và `pnpm dev:stack` bình thường không khởi động SDK nào. Khi có biến, mỗi dịch vụ gửi span với `service.name` riêng:

| Dịch vụ | `service.name` | Code |
|---|---|---|
| Next.js (BFF) | `invoice-web` | `apps/web/src/instrumentation.ts`, `apps/web/src/otel.node.ts` |
| NestJS API | `invoice-api` | `apps/api/src/otel.ts`, `apps/api/src/otel-api.ts` |
| Worker BullMQ | `invoice-worker` | `apps/api/src/otel-worker.ts`, `apps/api/src/common/otel/trace-context.ts` |
| FastAPI AI | `invoice-ai` | `apps/ai/app/otel.py` |

## Biến môi trường

Biến chuẩn của OpenTelemetry, cả Node và Python SDK đều tự đọc từ **môi trường của process**:

| Biến | Ví dụ | Ghi chú |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://otlp-gateway-prod-<region>.grafana.net/otlp` | SDK tự thêm `/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Basic%20<base64 của instanceId:token>` | **Bí mật.** Dấu cách viết là `%20` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Mặc định đã là giá trị này |

API không đọc file env (`ignoreEnvFile`), còn `pydantic-settings` của AI không đẩy biến trong file env vào `os.environ`. Vì vậy đặt các biến trên **trong shell** trước khi chạy stack, không đặt trong file env của từng app.

## Tạo stack Grafana Cloud (một lần)

1. Đăng ký Grafana Cloud bản Free (không cần thẻ). Giới hạn lúc viết: 50 GB trace, 14 ngày lưu, 3 user; kiểm lại trên trang giá trước khi dựa vào.
2. Trong trang quản lý stack: **OpenTelemetry → Configure**. Tạo token (chỉ cần quyền ghi trace), trang sẽ hiện sẵn ba biến ở trên.
3. Lưu ba biến vào một file **ngoài repo**, ví dụ `~/.config/invoice-otel.env`, dạng `export OTEL_EXPORTER_OTLP_ENDPOINT=...`. Không commit, không dán token vào issue hay log.

## Chạy và xem trace

```bash
source ~/.config/invoice-otel.env
LLM_PROVIDER=fake pnpm dev:stack
```

Upload một hoá đơn tổng hợp ở http://localhost:3000, rồi vào Grafana: **Explore → Tempo**, TraceQL:

```text
{ resource.service.name = "invoice-worker" && name = "extraction process" }
```

Mở trace: một lần upload đi qua `invoice-web` (route `/api/documents/upload`) → `invoice-api` (`POST /documents/upload`, Postgres) → `invoice-worker` (span `extraction process`, gọi AI) → `invoice-ai` (`POST /extract`, span `chat <model>` có model và số token).

![Một lần upload là một trace: 4 dịch vụ, 51 span, kể cả đoạn qua hàng đợi BullMQ (Grafana Cloud Tempo, LLM fake, 2026-11-26)](../assets/t7.1-upload-trace.png)

Trên stack Grafana Cloud mới, dòng "Trial" nghĩa là gói **Cloud Free** đang được dùng thử không giới hạn mức dùng. Hết hạn thử thì mức dùng bị giới hạn theo gói Free, không tự chuyển sang trả phí. Không thêm thẻ, không bấm "Upgrade".

## Trace đi qua hàng đợi như thế nào

API không gửi tiếp header `traceparent` thô: nó lưu `traceparent` của **span đang chạy** vào job data (`activeTraceparent()`), worker đọc lại và mở span `CONSUMER` làm con của span đó (`runInConsumerSpan()`): `extraction process` cho mỗi lần thử, `extraction settle` cho lần ghi `failed` cuối cùng khi job hết lượt thử (BullMQ gọi listener `failed` ngoài span của lần thử, nên phải mở span riêng mới nằm chung trace). Lời gọi `fetch` sang AI được instrumentation undici gắn `traceparent` của worker. Khi tracing bật thì không ai tự set header bằng tay, để không bao giờ có hai header. Khi tracing tắt, worker vẫn chuyển `traceparent` của job sang AI như trước T7.1 (nếu job có).

## Những gì không bao giờ vào span

- Query string: bị cắt khỏi `url.full`, `http.url`, `http.target`; `url.query` thành `REDACTED`.
- Nội dung tài liệu, prompt, câu trả lời của model: span LLM chỉ có tên provider, model, số token, số ảnh, cờ `truncated`.
- Thông báo lỗi, kể cả của thư viện (pg, http, express, undici, FastAPI, httpx): event `exception` bị bỏ, status không có message, chỉ còn `error.type` (mã lỗi hoặc tên lớp lỗi). Node làm ở `RedactingProcessor` (`onEnding`), Python ở `RedactingExporter` (span Python đã khoá khi kết thúc).
- Giá trị tham số SQL (chỉ câu lệnh có tham số của Drizzle).
- Redis/BullMQ không được instrument: worker poll Redis liên tục, sẽ đốt quota free bằng span vô nghĩa.
- Probe `/health`: không có span, kể cả câu `SELECT 1` của `/health/ready` (pg chỉ ghi query nằm trong một request hoặc job đã có span).
