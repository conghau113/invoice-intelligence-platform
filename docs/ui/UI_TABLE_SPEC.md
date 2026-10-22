#  Base-Style Enterprise Data Table — UI/UX Specification

## 1. Mục tiêu

Tài liệu này mô tả quy tắc thiết kế và hoạt động của một **Enterprise Admin Data Table**, dựa trên giao diện  Base-Style – Customers mà tôi cung cấp.

Mục tiêu là tái tạo gần nhất có thể bố cục, cách hiển thị và hành vi của giao diện tham chiếu. Không tự suy đoán các nghiệp vụ chưa được xác nhận từ ảnh.

### Các yêu cầu bắt buộc

1. Table container phải có chiều cao ổn định, phụ thuộc vào không gian khả dụng của viewport/layout, không phụ thuộc vào số lượng dòng dữ liệu.
2. Bảng không được tự co chiều cao khi chỉ có một vài bản ghi.
3. Thanh cuộn ngang phải luôn có vùng hiển thị riêng ở đáy table, ngay phía trên footer, kể cả khi dữ liệu ít hoặc các cột đang vừa trong màn hình.
4. Footer phải luôn nằm ở đáy table container và không cuộn theo dữ liệu.
5. Khi phóng to, thu nhỏ hoặc resize cửa sổ trình duyệt, layout phải tự điều chỉnh mà không bị vỡ.
6. Header và body phải đồng bộ vị trí cuộn ngang để tên cột luôn thẳng hàng với dữ liệu.
7. Khi có nhiều dòng, dữ liệu phải cuộn bên trong vùng table, không làm toàn bộ trang tăng chiều cao vô hạn.

## 2. Quy tắc layout tổng thể

Ứng dụng sử dụng layout chiếm toàn bộ chiều cao viewport.

- **Topbar:** nằm ổn định ở phía trên cùng; logo/tên ứng dụng bên trái, tìm kiếm toàn hệ thống ở khu vực giữa và thông tin người dùng bên phải.
- **Sidebar:** nằm bên trái, có chiều rộng ổn định; menu được chia thành các nhóm chức năng, mục đang chọn sử dụng màu accent nổi bật. Có thể thu gọn sidebar bằng nút ở đáy.
- **Main content:** chiếm toàn bộ chiều rộng và chiều cao còn lại. Các phần tử flex/grid con cần `min-width: 0` và `min-height: 0` để tránh lỗi overflow.
- **Page header:** tiêu đề trang, badge tổng số bản ghi, mô tả ngắn và nút refresh.
- **Information banner:** hiển thị thông báo như read-only demo nếu cần.
- **Table toolbar:** ô tìm kiếm bên trái; số lượng dòng được chọn và menu thao tác bên phải.
- **Table panel:** chiếm phần chiều cao còn lại được cấp cho khu vực nội dung. Chiều cao không phụ thuộc số dòng.
- **Table footer:** nằm bên trong table panel, hiển thị tổng số bản ghi bên trái và pagination bên phải.

Không dùng toàn bộ `body` làm vùng cuộn chính cho dữ liệu bảng. Table body phải có vùng cuộn riêng.

## 3. Cấu trúc table container

Cấu trúc logic:

```text
TablePanel
├── TableToolbar
├── TableViewport
│   ├── TableHeader
│   └── TableBody
├── PersistentHorizontalScrollbar
└── TableFooter
```

Quy tắc:

- `TablePanel`: layout flex theo chiều dọc, chiều cao bị giới hạn, `overflow: hidden`.
- `TableToolbar`: không cuộn theo dữ liệu. Có thể đặt bên ngoài border của table panel nếu phù hợp với layout hiện tại.
- `TableViewport`: chiếm phần chiều cao co giãn còn lại.
- `TableHeader`: luôn hiển thị khi cuộn dọc.
- `TableBody`: chứa các dòng dữ liệu, cuộn dọc khi cần.
- `PersistentHorizontalScrollbar`: vùng scrollbar riêng, luôn nằm ngay phía trên footer.
- `TableFooter`: không co lại, luôn nằm ở đáy table panel.

### Quy tắc chiều cao

- Chiều cao table được xác định bởi không gian khả dụng, không tính theo `rows.length`.
- Với 0, 1, 5 hoặc hàng trăm bản ghi, chiều cao bên ngoài của table panel vẫn giữ nguyên nếu kích thước viewport không thay đổi.
- Khi dữ liệu ít, vùng body vẫn giữ phần không gian trống thay vì co lại.
- Khi dữ liệu nhiều, chỉ vùng body cuộn dọc.
- Scrollbar ngang và footer không được nằm bên trong vùng cuộn dọc của các dòng.
- Ưu tiên flex layout dựa trên viewport thay vì hard-code chiều cao pixel dễ vỡ trên các kích thước màn hình khác nhau.

## 4. Quy tắc thanh cuộn ngang — yêu cầu quan trọng nhất

Chỉ sử dụng `overflow-x: auto` là chưa đủ. Trình duyệt hoặc hệ điều hành có thể tự ẩn scrollbar khi nội dung không tràn hoặc khi sử dụng overlay scrollbar.

### Hành vi bắt buộc

1. Dành riêng một vùng hiển thị scrollbar ngang ở đáy table panel, ngay phía trên footer.
2. Vùng này luôn giữ nguyên vị trí khi dữ liệu có 0, 1, 5 hoặc nhiều dòng.
3. Khi tổng chiều rộng các cột lớn hơn viewport, người dùng có thể cuộn ngang để xem các cột còn lại.
4. Khi nội dung vừa trong viewport, vùng track vẫn phải hiển thị. Thumb có thể chiếm gần hết hoặc toàn bộ track và không cần di chuyển được.
5. Nếu trình duyệt tự ẩn native scrollbar, phải chủ động triển khai track hiển thị hoặc custom scrollbar được đồng bộ với table.
6. Cuộn ngang phải đồng bộ giữa header và body.
7. Khi resize cửa sổ hoặc thay đổi chiều rộng container, scrollbar phải cập nhật kích thước.
8. Không đặt scrollbar sau dòng dữ liệu cuối cùng theo normal document flow, vì vị trí của nó sẽ thay đổi theo số dòng.
9. Scrollbar không được bị footer che hoặc chồng lên footer.

### Hướng triển khai đề xuất

Sử dụng một nguồn trạng thái duy nhất cho vị trí cuộn ngang và đồng bộ `scrollLeft` giữa vùng scrollbar, header và body.

Nếu triển khai custom scrollbar:

- Tạo wrapper riêng có chiều cao ổn định.
- Tính toán kích thước và vị trí thumb dựa trên `clientWidth`, `scrollWidth` và `scrollLeft`.
- Cập nhật khi container resize, chiều rộng cột thay đổi hoặc layout thay đổi.
- Có thể dùng `ResizeObserver` khi phù hợp và phải cleanup observer/event listener.
- Nếu scrollbar có tương tác, hỗ trợ keyboard và accessible label.
- Khi nội dung vừa viewport, vẫn hiển thị track nhưng không tạo ra khoảng cuộn giả.

Không tạo hai scrollbar độc lập có vị trí cuộn khác nhau. Nếu thư viện table đang dùng có sẵn scrollbar đáp ứng được yêu cầu, ưu tiên tận dụng trước khi tự triển khai.

## 5. Quy tắc chiều rộng cột và overflow

- Đặt chiều rộng hoặc `min-width` cho các cột cần thiết để giữ nội dung dễ đọc.
- Cho phép tổng chiều rộng các cột lớn hơn viewport; scrollbar ngang sẽ giúp truy cập phần bị khuất.
- Không ép tất cả cột co nhỏ đến mức dữ liệu không thể đọc được.
- Header cell và body cell phải thẳng hàng chính xác.
- Padding và alignment trong từng cột phải nhất quán.
- Các giá trị dài như email có thể dùng ellipsis (`...`) để không phá vỡ layout.
- Nếu truncate làm mất thông tin quan trọng, cung cấp tooltip hoặc cách xem giá trị đầy đủ.
- Thứ tự cột phải ổn định.
- Chỉ dùng sticky/fixed column khi có yêu cầu rõ ràng; không vô tình cố định cột.

## 6. Quy tắc header

- Header có nền tối riêng, phân biệt rõ với các dòng dữ liệu.
- Tên cột ngắn gọn, có thể viết hoa như giao diện tham chiếu; màu chữ phụ nhưng đủ tương phản.
- Cột checkbox chọn dòng nằm đầu tiên.
- Chỉ hiển thị icon sort/filter ở các cột hỗ trợ chức năng đó.
- Sort cần phân biệt các trạng thái: chưa sắp xếp, tăng dần và giảm dần.
- Filter cần thể hiện được khả năng lọc và trạng thái filter đang được áp dụng nếu có.
- Header vẫn hiển thị khi cuộn dọc.
- Header và body luôn đồng bộ khi cuộn ngang.

## 7. Quy tắc row và cell

- Chiều cao các dòng nhất quán.
- Dùng các màu nền tối xen kẽ nhẹ hoặc một cách phân biệt dòng tương tự.
- Có hover state rõ ràng.
- Dòng được chọn phải có trạng thái khác biệt với hover.
- Checkbox chọn dòng nằm đầu mỗi row.
- Các giá trị như tên công ty chỉ dùng màu accent để thể hiện khả năng tương tác khi chúng thực sự mở trang chi tiết hoặc thực hiện hành động.
- Nội dung dài nên được truncate có chủ đích thay vì tự xuống dòng làm tăng chiều cao row.
- Alignment phải nhất quán theo loại dữ liệu.
- Ưu tiên hiển thị một dòng với ellipsis, trừ khi yêu cầu nghiệp vụ cho phép xuống dòng.

## 8. Quy tắc status badge

Badge có dạng pill, nhỏ gọn và nhất quán về chiều cao, padding, border radius và font weight.

- `Active`: nền xanh lá/xanh teal.
- `Created`: nền xanh dương.
- `Inactive`: nền cam/vàng cam.
- Đảm bảo độ tương phản giữa chữ và nền.
- Không chỉ dùng màu để biểu diễn trạng thái; luôn hiển thị nhãn chữ.

Đây là màu tham chiếu từ screenshot. Nếu dự án đã có design token, ưu tiên sử dụng token hiện tại.

## 9. Toolbar và chọn dòng

- Search nằm bên trái toolbar.
- Selected count và menu thao tác nằm bên phải.
- Số lượng được chọn cập nhật theo checkbox.
- Phải xác định phạm vi checkbox ở header. Mặc định đề xuất: chọn/bỏ chọn toàn bộ dòng của trang hiện tại, không phải toàn bộ kết quả trên mọi trang, trừ khi nghiệp vụ yêu cầu khác.
- Xác định rõ lựa chọn có được giữ lại khi đổi trang hoặc filter hay không.
- Vô hiệu hóa thao tác hàng loạt khi chưa chọn dòng nào nếu phù hợp.
- Chỉ hiển thị các thao tác thực sự được hỗ trợ.
- Với read-only/demo mode, vô hiệu hóa mọi thao tác thay đổi dữ liệu và không hiển thị thông báo thành công giả.

## 10. Search, filter, sort và pagination

Screenshot cho thấy các control này nhưng không xác nhận chính xác nghiệp vụ phía sau. Hãy tuân theo yêu cầu của dự án hiện tại.

- **Search:** xác định các trường được tìm kiếm, phân biệt hoa/thường và debounce nếu cần.
- **Column filter:** mỗi bộ lọc áp dụng đúng cột tương ứng và thể hiện trạng thái đang lọc.
- **Sorting:** xác định các cột hỗ trợ sort và quy tắc đổi chiều sắp xếp.
- **Pagination:** footer giữ nguyên ở đáy panel; tổng số bản ghi bên trái và điều hướng trang bên phải.
- Disable nút đầu/trước ở trang đầu và nút sau/cuối ở trang cuối.
- Chỉ thêm lựa chọn page size nếu sản phẩm hỗ trợ.
- Khi search/filter khiến trang hiện tại không còn hợp lệ, chuyển về trang hợp lệ, thường là trang 1.
- Loading, error, empty và no-results state không được làm co panel hoặc di chuyển scrollbar/footer.

## 11. Hành vi khi resize và zoom

- Khi resize hoặc zoom trình duyệt, sidebar và main content vẫn giữ đúng quan hệ bố cục.
- Main content/table panel co theo chiều rộng khả dụng; các phần tử flex/grid con cần `min-width: 0`.
- Cột rộng vẫn có thể truy cập thông qua cuộn ngang.
- Vùng scrollbar luôn ở đáy table panel.
- Footer nằm ngay dưới scrollbar.
- Bảng rộng không được khiến toàn bộ ứng dụng tràn ngang.
- Khi viewport thấp hơn, vùng body giảm chiều cao và cuộn; footer vẫn nằm trong panel.
- Kiểm thử ở nhiều kích thước viewport và mức zoom, không chỉ tại kích thước screenshot.

## 12. Quy tắc giao diện dark theme

Ưu tiên design token có sẵn trong dự án. Phân cấp màu tham chiếu:

- Nền toàn trang: navy rất tối/gần đen.
- Topbar/sidebar: navy sáng hơn nền trang một mức.
- Table panel và toolbar: nền tối với border xanh xám mảnh.
- Chữ chính: trắng ngà/gần trắng.
- Chữ phụ và nhãn cột: xám xanh dịu.
- Accent: cyan/xanh dương sáng cho menu đang chọn, giá trị tương tác, trang pagination đang chọn và control đang active.
- Border: xanh xám nhẹ, không dùng trắng sáng.
- Bo góc vừa phải cho panel, input, banner và menu active.
- Mật độ giao diện compact theo phong cách enterprise; spacing và alignment phải nhất quán.
- Focus, hover, disabled và selected state phải phân biệt được.
- Đảm bảo độ tương phản đủ đọc.

Không hard-code màu nếu dự án đã có theme/token nhất quán.

## 13. Loading, empty, error và read-only state

Hình học bên ngoài của table phải ổn định trong mọi trạng thái.

- **Loading:** hiển thị spinner hoặc skeleton trong body; scrollbar và footer giữ nguyên vị trí.
- **Empty dataset:** hiển thị empty state trong body; panel không co chiều cao.
- **No search results:** hiển thị thông báo không tìm thấy và cách xóa filter nếu được hỗ trợ.
- **Error:** hiển thị lỗi và nút retry trong khu vực nội dung; không làm panel co lại.
- **Read-only demo:** hiển thị banner rõ ràng và vô hiệu hóa thao tác thay đổi dữ liệu.
- **Disabled action:** thể hiện rõ trạng thái disabled và không giả lập thành công.

## 14. Accessibility

- Ưu tiên semantic table/grid markup khi phù hợp.
- Checkbox, sort, filter, pagination và custom scrollbar phải có accessible name.
- Có keyboard focus dễ nhìn.
- Control tương tác phải dùng được bằng bàn phím.
- Không biểu diễn trạng thái chỉ bằng màu sắc.
- Nếu dùng custom scrollbar, kiểm tra khả năng truy cập bằng bàn phím và screen reader; ưu tiên cơ chế cuộn native khi đáp ứng được yêu cầu.

## 15. CSS layout tham khảo

Đây là khung layout ban đầu, không phải toàn bộ implementation:

```css
.app-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-topbar {
  flex: 0 0 auto;
}

.app-below-topbar {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.app-sidebar {
  flex: 0 0 var(--sidebar-width);
  min-height: 0;
  overflow: auto;
}

.app-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.page-content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.table-panel {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--table-border);
  border-radius: var(--table-radius);
}

.table-viewport {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.table-horizontal-scrollbar {
  flex: 0 0 10px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  /* Vùng này phải luôn hiển thị, kể cả khi nội dung vừa viewport. */
}

.table-footer {
  flex: 0 0 auto;
}
```

Lưu ý:

- CSS trên chưa đủ để đảm bảo native scrollbar luôn hiển thị trên mọi hệ điều hành. Phải chủ động triển khai vùng scrollbar luôn hiện và đồng bộ vị trí cuộn.
- Kiểm tra thư viện table đang dùng có hỗ trợ horizontal scrollbar hay không trước khi thêm scrollbar thứ hai.
- Không đặt chiều cao `.table-panel` dựa theo số lượng row.
- Kiểm tra DOM thực tế của thư viện trước khi quyết định đặt overflow và sticky header.

## 16. Acceptance criteria

- [ ] Table panel giữ nguyên chiều cao khi có 0, 1, 5 hoặc hàng trăm dòng, nếu viewport không thay đổi.
- [ ] Vùng scrollbar ngang luôn hiển thị ngay phía trên footer.
- [ ] Scrollbar không đổi vị trí dọc theo số lượng dòng.
- [ ] Footer luôn ở đáy panel và không cuộn theo dữ liệu.
- [ ] Header vẫn hiển thị khi cuộn dọc.
- [ ] Header và body luôn thẳng hàng khi cuộn ngang.
- [ ] Có thể cuộn đến cột cuối cùng khi tổng chiều rộng nội dung vượt viewport.
- [ ] Khi nội dung vừa viewport, track vẫn hiện nhưng không tạo khoảng cuộn giả.
- [ ] Resize/zoom không làm vỡ overflow hoặc che footer.
- [ ] Empty/loading/error/no-results không làm thay đổi hình học panel.
- [ ] Không xuất hiện scrollbar trùng lặp hoặc mất đồng bộ.
- [ ] Read-only mode ngăn thao tác thay đổi dữ liệu và thông báo rõ ràng.

## 17. Chỉ dẫn cho Claude Code

Trước khi code:

1. Kiểm tra layout hiện tại, theme token, thư viện table và cách xử lý overflow.
2. Xác định container nào đang quyết định chiều cao table và phần tử nào đang quản lý cuộn dọc/ngang.
3. Tái sử dụng convention và component sẵn có; không thay toàn bộ table stack nếu không có lý do rõ ràng.
4. Triển khai hành vi layout trước, sau đó mới hoàn thiện styling và tương tác.
5. Không tự tạo nghiệp vụ hoặc hành vi chưa được xác nhận chỉ dựa trên screenshot.

Sau khi code:

1. Chạy các lệnh lint, typecheck và test hiện có.
2. Kiểm thử với 0, 1, 5 và nhiều dòng.
3. Kiểm thử viewport hẹp/rộng và nhiều mức zoom.
4. Kiểm tra cuộn ngang, căn chỉnh header và vị trí footer.
5. Báo cáo những gì đã kiểm thử, kết quả và hạn chế còn lại.

Nếu yêu cầu xung đột với kiến trúc hiện tại, hãy giải thích xung đột và đề xuất thay đổi nhỏ nhất nhưng vững chắc. Không được âm thầm bỏ yêu cầu chiều cao ổn định hoặc scrollbar ngang luôn hiển thị.
