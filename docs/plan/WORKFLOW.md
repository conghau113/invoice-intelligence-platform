# Quy trình làm việc: Claude Code làm, mình review và học

> Áp dụng cho mọi task trong `docs/plan/milestones/`. Mục tiêu kép: ra sản phẩm để "flex" và **giải thích được mọi thứ**.

## 1. Phân vai

| Ai | Làm gì |
|---|---|
| **Bạn** | Chọn task, duyệt kế hoạch của agent, chạy thử, đọc diff, trả lời cổng hiểu, commit, cập nhật `TASKS.md` |
| **Claude Code** (chính) | Lập kế hoạch, viết code nhiều file, chạy test/lệnh kiểm chứng, giải thích |
| **Cursor** (IDE) | Đọc code, sửa nhỏ một chỗ, xem diff, hỏi nhanh về một đoạn code — dùng quota riêng của Cursor, đỡ tốn quota Claude |
| **Subagent `code-reviewer` / `security-auditor`** | Review diff trong ngữ cảnh mới (không thiên vị code vừa viết) |
| **Chat claude.ai** (nơi lập kế hoạch này) | Sửa kế hoạch, hỏi khái niệm sâu, viết task cho mốc khi cần đổi phạm vi |

Cursor đọc cùng ngữ cảnh qua `.cursor/rules/project.mdc` (alwaysApply), trỏ tới `CLAUDE.md` và file này. Kiểm chứng ở T0.9 bằng cách hỏi Cursor "dự án đang ở mốc nào". Môi trường: code trong WSL2, Claude Code chạy trong terminal Ubuntu, Cursor mở thư mục WSL (`docs/setup/WSL2.md`).

### Nguồn chính của từng loại thông tin (tránh mâu thuẫn)

| Thông tin | Nguồn chính | Nơi khác chỉ được trỏ tới, không chép lại |
|---|---|---|
| Trạng thái task, giờ thực tế, việc phát sinh | `docs/plan/TASKS.md` | — |
| Spec của task (yêu cầu, ngoài phạm vi, xong khi) | `docs/plan/milestones/M*.md` | TASKS.md chỉ có tên task |
| Thứ tự mốc, giả định, timeline, cắt giảm | `docs/plan/ROADMAP.md` | — |
| Quyết định kiến trúc và lý do | `docs/architecture/adr/` | ARCHITECTURE.md mô tả trạng thái hiện tại, trỏ ADR |
| Hệ thống hiện tại trông thế nào | `docs/architecture/*.md` | — |
| Mục tiêu đo được và kết quả đo | `docs/product/NFR.md` (+ báo cáo trong `docs/reports`, `eval/reports`) | README chỉ trích số và link |
| Ràng buộc dữ liệu, điều khoản, giấy phép | `docs/LEGAL.md` | SECURITY.md trỏ tới |
| Quy tắc cho agent | `CLAUDE.md` | `.cursor/rules` trỏ tới |
| Học được gì, agent sai gì | `docs/learning-log.md` | README mục "How I used AI" trích ví dụ |

## 2. Vòng lặp một task (60–240 phút)

```text
0. git switch -c task/T1.3-rls                      (một nhánh mỗi task)
1. Claude Code: /clear  →  /task T1.3               (skill đọc spec task, vào plan mode)
2. Đọc kế hoạch agent đưa ra (file sẽ sửa, cách làm, phương án bị loại).
   Chưa hiểu hoặc thấy lệch spec → hỏi lại TRƯỚC khi duyệt. Duyệt → agent làm.
3. Agent chạy các lệnh "Xong khi" và dán output làm bằng chứng.
4. Bạn: tự chạy lại ít nhất 1 lệnh kiểm chứng + mở app xem bằng mắt (nếu có UI).
5. Bạn: đọc diff trong Cursor (Source Control). Đánh dấu chỗ chưa hiểu.
6. "Use the code-reviewer subagent to review this diff against the task spec" → sửa lỗi Cao/Vừa.
7. /gate  → trả lời 3 câu hỏi khái niệm kiểu phỏng vấn (là gì và vai trò, cách hoạt động, đánh đổi), không cần mở code hay log. Chưa PASS → hỏi khái niệm, không xin thêm code.
8. Ghi 2–3 dòng vào docs/learning-log.md; cập nhật TASKS.md (DONE, giờ thực tế).
9. Commit (Conventional Commits, ví dụ "feat(api): enforce tenant isolation with RLS (T1.3)") → merge vào main.
```

Mẹo prompt khi review (học nhanh hơn xin code):
- "Giải thích luồng chạy của request X từ đầu đến cuối, kèm file:dòng."
- "Đoạn nào trong diff này dễ sai nhất trong production? Vì sao?"
- "Nếu bỏ dòng này thì test nào fail? Chạy thử cho tôi xem."
- "Giải thích bằng tiếng Việt khái niệm <X> như cho người mới, kèm ví dụ trong code này."

## 3. Quy tắc (không thương lượng)

1. **Một task một lúc, một nhánh, một phiên.** `/clear` giữa các task (tài liệu chính thức: context đầy làm agent kém đi).
2. **Không duyệt kế hoạch mình chưa hiểu.** Duyệt mù = mất quyền giải thích.
3. **Không nhận code chưa chạy.** Agent phải đưa output; bạn tự chạy lại ít nhất một lệnh.
4. **Sửa sai 2 lần không được → `/clear` và viết lại prompt** kèm điều đã học (theo best practices chính thức).
5. **Agent không tự commit/push.** Bạn commit sau khi qua cổng hiểu.
6. **Không mở rộng phạm vi trong task.** Phát hiện việc mới → ghi vào `TASKS.md` dưới "Phát sinh", làm sau.
7. **Quyết định kiến trúc mới → `/adr`.** Không sửa quyết định của ADR đã Accepted; viết ADR mới thay thế khi có bằng chứng (ADR không phải bất biến, nhưng thay đổi phải có lý do ghi lại).
8. **Dữ liệu chỉ là dữ liệu tổng hợp.** Không dán hóa đơn thật vào prompt, test, log.
9. **Kiểm tra không AI cuối mỗi mốc.** Trả lời 3 câu cuối file mốc mà không mở agent.
10. **Không phát sinh chi phí.** Không thêm dịch vụ trả phí, không bật billing, không nâng gói, không mua tên miền khi chưa được Hậu duyệt rõ ràng. Agent phải dừng và hỏi.
11. **Mức duyệt theo rủi ro:**
    - Mọi task: duyệt kế hoạch trước khi agent code (đây là lúc học).
    - Thay đổi kiến trúc, bảo mật, auth/tenant, dữ liệu, giấy phép hoặc chi phí: trình bày đủ 5 bước *tìm hiểu → phân tích → đối chiếu (ADR, LEGAL, NFR) → review rủi ro → đề xuất áp dụng* và chờ duyệt.
    - Sửa nhỏ trong phạm vi task đã duyệt: làm luôn, báo trong tóm tắt.
    - Lệch kế hoạch hoặc mở rộng phạm vi: dừng, ghi "Phát sinh", xin duyệt.

## 4. Chiến lược test

| Tầng | Công cụ | Kiểm cái gì | Ví dụ |
|---|---|---|---|
| Unit | Vitest, pytest | Logic thuần: rules, state machine, chuẩn hoá, so khớp eval | T2.2, T3.3 |
| Integration | Vitest + Testcontainers (Postgres/Redis thật) | RLS, transaction, queue, API với DB thật | T1.8, T2.3 |
| Contract | Test chéo TS ↔ Python trên cùng JSON Schema | Schema không lệch giữa 2 ngôn ngữ | T0.5 |
| E2E | Playwright | Luồng người dùng thật qua trình duyệt | T1.8, T2.10, T3.4 |
| AI eval | eval runner + dataset cố định | Độ chính xác, chi phí, độ trễ | T4.3, T5.6 |
| Load | k6 | p95, error rate, 429 | T6.6 |
| Resilience | Kịch bản kill container | Không mất/không trùng job | T6.7 |

Test đọc mã nguồn thành chuỗi rồi kiểm tra "có chứa chữ X" **không phải test hành vi** — không dùng kiểu đó. Test phải chạy code và kiểm tra kết quả.

LLM trong test: luôn dùng **fake provider** (fixture cố định) trong unit/integration/CI; chỉ eval mới gọi model thật.

## 5. Cổng tự động

Chia theo tầng để không chậm khi code:

| Tầng | Lệnh | Khi nào |
|---|---|---|
| Nhanh | `pnpm check:fast` (lint, typecheck, unit) | Sau mỗi thay đổi trong task |
| Đủ | `pnpm check:full` (thêm integration, e2e, schema drift, i18n, ADR, links, gitleaks, licence) | Trước khi commit/merge; CI chạy lại |
| Đặc biệt | `eval.yml`, k6, Lighthouse | Khi đổi prompt/model, khi đo hiệu năng |

| Lệnh | Chặn |
|---|---|
| `pnpm lint`, `pnpm typecheck` | Lỗi style, lỗi type |
| `pnpm test`, `uv run pytest` | Hành vi sai |
| `pnpm check:schema` | Schema Zod và file sinh cho Python lệch nhau |
| `pnpm check:i18n` | Thiếu khóa vi/en, lệch tham số |
| `pnpm check:adr` | ADR không có trong bảng index |
| `pnpm check:links` | Link nội bộ trong docs gãy |
| `gitleaks` | Lộ bí mật |
| licence check | Thư viện có giấy phép ngoài danh sách cho phép (LEGAL.md) |
| `eval.yml` (khi đổi prompt/model) | Độ chính xác tụt dưới baseline |

Mỗi cổng mới phải có **một lần thử cho fail** (dữ liệu sai → exit 1). Cổng không thể fail là cổng vô dụng.

## 6. Quản lý quota Claude Code Pro

Tài liệu và tổng hợp cộng đồng (10/2026): gói Pro có giới hạn theo cửa sổ 5 giờ và giới hạn theo tuần, **dùng chung giữa claude.ai và Claude Code**; Anthropic không công bố con số cụ thể; Pro đã được nâng giới hạn nhiều lần trong 2026. Vì vậy:

- 3 ngày đầu: cuối ngày chạy `/usage`, ghi vào learning-log (dùng bao nhiêu % tuần cho bao nhiêu task).
- Model mặc định Sonnet cho task thường; chỉ dùng model mạnh hơn cho thiết kế khó / gỡ lỗi khó.
- `/clear` giữa task; CLAUDE.md < 200 dòng; tắt MCP server không dùng.
- Việc nhỏ (đổi tên, sửa 1 dòng, hỏi về 1 hàm) làm trong Cursor.
- Đừng để biến `ANTHROPIC_API_KEY` trong môi trường shell: Claude Code sẽ dùng key đó và tính tiền theo API.
- Nếu sau 1 tuần thường xuyên hết quota trước khi hết ngày → trước hết giảm việc cho Claude (chuyển việc nhỏ sang Cursor, giảm effort); nâng gói là chi phí → chỉ khi bạn tự quyết dựa trên số đo.
- Không dùng proxy kiểu 9Router để "tận dụng" gói subscription: điều khoản Anthropic (02/2026) không cho phép dùng thông tin đăng nhập Free/Pro/Max để route request qua công cụ bên thứ ba.

## 7. Khi bị kẹt

| Tình huống | Làm gì |
|---|---|
| Agent sửa mãi không được | Dừng. `/clear`. Viết prompt mới mô tả triệu chứng, nơi nghi ngờ, điều kiện "đã sửa". |
| Lỗi môi trường (Docker, Keycloak) quá 1 giờ | Ghi lại, hỏi trong chat claude.ai kèm log; chuyển sang task không phụ thuộc. |
| Spec task sai/thiếu | Sửa spec trong file mốc trước (và ADR nếu là kiến trúc), rồi mới code. |
| Ước tính vượt > 2 lần | Ghi lý do vào TASKS.md; xem bảng cắt giảm trong ROADMAP.md. |

## 8. Kết thúc phiên làm việc

Cập nhật khối "Điểm dừng hiện tại" trong `TASKS.md` (mốc, task, chặn bởi gì, ngày) để phiên sau — của bạn hay của agent — bắt đầu không phải đoán.
