# Invoice Intelligence Platform — Giới thiệu dự án

> *Tên tạm.* Nền tảng SaaS đa tenant biến hóa đơn (XML hóa đơn điện tử Việt Nam, PDF, ảnh chụp) thành dữ liệu đã kiểm chứng, tra cứu được, và trả lời câu hỏi kèm trích dẫn nguồn. Một người phát triển end-to-end (Nguyễn Công Hậu) cùng AI coding agent, theo quy trình có tài liệu và cổng kiểm tra.
>
> 🇬🇧 English: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)

**Trạng thái:** đã xong kế hoạch, bắt đầu triển khai. Mọi con số ghi *mục tiêu* sẽ được thay bằng số đo thật kèm link báo cáo khi xong từng mốc.

## Dự án làm gì

| Đầu vào | Xử lý | Đầu ra |
|---|---|---|
| **XML** hóa đơn điện tử (bắt buộc định dạng XML theo khoản 1 Điều 12 NĐ 123/2020) | Parser xác định, chống XXE | Hóa đơn có cấu trúc, chính xác |
| **PDF/ảnh** hóa đơn, biên lai (mọi ngôn ngữ) | LLM thị giác bị ràng buộc bởi JSON Schema → kiểm tra schema → quy tắc nghiệp vụ | Hóa đơn có cấu trúc + độ tin cậy từng field + cảnh báo |
| **Câu hỏi** tiếng Việt/Anh ("Quý 3 đã trả ACME bao nhiêu?") | Phân loại câu hỏi → truy hồi hybrid (vector + full-text) hoặc truy vấn có cấu trúc đã kiểm tra → sinh câu trả lời | Câu trả lời có **trích dẫn** hóa đơn nguồn, hoặc "không biết" |

Xung quanh lõi đó: người duyệt kiểm tra, tiến độ realtime, phân quyền, cách ly tenant chặt, số đo chất lượng AI, quan sát hệ thống đầy đủ.

## Điểm khó (để nói với nhà tuyển dụng)

- **Đa tenant chịu được lỗi của dev:** Row-Level Security của PostgreSQL bên dưới bộ lọc ứng dụng; quên `WHERE` thì ra 0 dòng chứ không ra dữ liệu công ty khác. Có test chứng minh trong CI.
- **Coi AI là thành phần không tin cậy:** output ràng buộc schema, quy tắc nghiệp vụ, người duyệt, đo độ chính xác trên bộ dữ liệu cố định, theo dõi chi phí mỗi tài liệu, đổi được provider.
- **Pipeline bất đồng bộ chịu lỗi:** hàng đợi, retry, backoff + jitter, xử lý 429 của provider, circuit breaker, xử lý idempotent, diễn tập sự cố.
- **Bảo mật cho tính năng LLM:** test prompt injection trực tiếp và gián tiếp, kiểm tra trích dẫn, model không bao giờ viết SQL, log không chứa PII.
- **Quan sát được:** một trace OpenTelemetry đi từ trình duyệt qua Next.js, NestJS, hàng đợi tới dịch vụ AI Python.

## Kiến trúc và công nghệ
Xem bản tiếng Anh (sơ đồ và bảng công nghệ giống hệt) và các tài liệu trong `docs/architecture/`.

## Cách tôi dùng AI
1. **Lập kế hoạch trước khi code:** PRD, kiến trúc, mô hình dữ liệu, API, pipeline AI, bảo mật, pháp lý, 18 ADR và 70 task được viết, đối chiếu nguồn công khai và chốt trước.
2. **Mỗi lần một task:** có đầu vào, phạm vi, điều kiện "xong khi" kiểm chứng được và câu hỏi review. Agent lập kế hoạch → tôi duyệt → agent làm và phải đưa bằng chứng.
3. **Cổng hiểu:** sau mỗi task tôi tự trả lời câu hỏi không dùng agent; chưa trả lời được thì chưa xong.
4. **Cổng tự động:** CI kiểm tra type, test (gồm test cách ly tenant với DB thật), khóa i18n, chỉ mục ADR, link tài liệu, bí mật.
5. **Nhật ký học:** học được gì và agent sai ở đâu, theo từng task.

## Chính sách dữ liệu và chi phí
Toàn bộ hóa đơn là **dữ liệu tổng hợp** sinh với seed cố định (mã số thuế sai chữ số kiểm tra, watermark `SAMPLE`). Không có dữ liệu thật của công ty hay cá nhân trong code, test, log hay prompt. Demo public chỉ cho xem và không gọi LLM. Chi phí vận hành 0đ: chạy local, demo trên Oracle Cloud Always Free + DuckDNS, CI trên GitHub Actions (repo public). Chi tiết: [LEGAL.md](LEGAL.md).
