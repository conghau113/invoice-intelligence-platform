# Grafana: dashboard và cảnh báo (task T7.3)

Nguồn sự thật của dashboard và cảnh báo trên Grafana Cloud. Sửa trên Grafana xong thì export lại vào đây, không để hai bản lệch nhau. Metric là gì, đến từ đâu: xem [OBSERVABILITY.md](../../docs/setup/OBSERVABILITY.md#metrics-task-t73).

| File | Nội dung |
|---|---|
| `dashboards/invoice-overview.json` | Dashboard "Invoice Intelligence: overview": RED của API, hàng đợi, token và chi phí LLM theo tenant (giá niêm yết), cache |
| `alerts/invoice-alerts.yaml` | 2 cảnh báo: `API error rate`, `Queue stuck` (định dạng provisioning của Grafana) |

## Token có quyền ghi metric

Token tạo ở T7.1 chỉ ghi trace. Vào **Grafana Cloud → stack → OpenTelemetry → Configure**, tạo token mới có scope `metrics:write` và `traces:write`, rồi thay giá trị trong `~/.config/invoice-otel.env` (ngoài repo). Endpoint giữ nguyên: SDK tự thêm `/v1/metrics`.

## Import dashboard

**Dashboards → New → Import** → tải `dashboards/invoice-overview.json` lên → chọn data source Prometheus của stack (`grafanacloud-<stack>-prom`) → **Import**.

## Tạo hai cảnh báo

Grafana Cloud không đọc file provisioning, nên tạo tay theo `alerts/invoice-alerts.yaml`:

1. **Alerting → Alert rules → New alert rule**.
2. Query A: data source `grafanacloud-<stack>-prom`, chế độ **Code**, dán `expr`, chọn **Instant**.
3. Expression: **Threshold**, input A, `Is above` với ngưỡng trong file (`0.05`, hoặc `300`).
4. Folder `Invoice Intelligence`, evaluation group `invoice-api` mỗi `1m`, pending period `2m`.
5. **Configure no data and error handling**: no data → `Normal` (không có traffic thì không phải lỗi).
6. Labels, summary, description: chép từ file. Contact point: `grafana-default-email` (email của tài khoản Grafana).

Ngày 2026-11-28, dashboard và hai rule đã được tạo trên stack của dự án qua API của Grafana (dùng phiên đăng nhập trên trình duyệt), từ đúng hai file này, và uid `grafanacloud-prom` đã được xác nhận. Kết quả kích hoạt thử: [OBSERVABILITY.md](../../docs/setup/OBSERVABILITY.md#kiểm-thật-ngày-2026-11-28).

Tạo xong, **More → Export** cả folder dưới dạng YAML, so với file trong repo. Nếu Grafana sửa gì khác thì cập nhật file. On-call/paging nằm ngoài phạm vi.

## Ngưỡng và lý do

| Cảnh báo | Điều kiện | Vì sao |
|---|---|---|
| API error rate | 5xx > 5% trong 5 phút, **chỉ khi** có ≥ 20 request trong cửa sổ đó, kéo dài 2 phút | Lưu lượng demo rất thấp: 1 lỗi trong 3 request đã là 33%. Ngưỡng 5% là điểm xuất phát, chưa đo |
| Queue stuck | cùng một job đứng đầu hàng đợi > 300 s (không phải tuổi của job), kéo dài 2 phút | Một hoá đơn một trang mất p95 12 s (NFR-04). Đầu hàng đứng yên 5 phút nghĩa là không worker nào nhận job, worker đang bị giữ sau khi provider trả 429 (T6.2, job vẫn nằm ở `waiting`), admin đã pause hàng đợi, hoặc không đọc được Redis. Không dùng tuổi của job, vì job failed được retry vẫn giữ thời điểm tạo và sẽ báo động ngay (code-reviewer T7.3) |

## Free tier

Mỗi series là một tổ hợp metric và nhãn. Bản Free tính theo số series đang hoạt động, với 1 điểm dữ liệu mỗi phút; code xuất mỗi 60 s đúng bằng mức này. Lúc viết (2026-11-28), trang [metrics](https://grafana.com/products/cloud/metrics/) ghi 10k series, còn trang [giá](https://grafana.com/pricing/) mới không nhắc giới hạn: kiểm lại trước khi dựa vào. Vượt giới hạn thì series mới bị bỏ, không tự tính tiền. Không thêm thẻ, không bấm "Upgrade".
