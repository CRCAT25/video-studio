// Chỉ dẫn cho Trợ lý AI theo từng vùng màn hình: gắn data-ai-help="<id>" lên vùng đó,
// read_page gửi kèm mục "Cách dùng màn này" của các vùng đang thấy. Viết cho Claude đọc: ngắn, đúng tên nút thật.

export const HINTS = {
  projects: {
    title: 'Danh sách dự án',
    text: 'Mỗi dự án là 1 video. Tạo mới: "+ Dự án mới" → chọn định dạng hoặc quy trình đã lưu → "Tiếp tục" → điền tiêu đề, kênh, skills → "Tạo dự án". Nút "Mở <tên>" vào bước đang làm của dự án.',
  },
  'new-project': {
    title: 'Hộp "Dự án mới"',
    text: 'Phần 1 chọn khung: tab "Gợi ý theo định dạng" (độ dài, chiều khung…) hoặc "Quy trình đã lưu", rồi "Tiếp tục". Phần 2: "Tiêu đề video" bắt buộc; "Kênh" là combobox; Skills chỉ nạp skill được tick; "Tham khảo video" tùy chọn. Tạo dự án chưa tốn token — các bước chỉ chạy khi bấm "Chạy" ở từng bước.',
  },
  'step-actions': {
    title: 'Nút của bước',
    text: '"Chạy" chạy bước lần đầu; "Chạy lại" (bước đã xong) hỏi lại rồi mới chạy. Nút có "$" là bước tốn tiền: luôn mở hộp "Xác nhận chi phí". Đổi model: combobox "Model của bước này" (click mở, click mục) trước khi chạy. "Đánh dấu xong" dành cho việc tay. "Sửa quy trình" thêm/bớt/đổi chỗ các bước chưa chạy của riêng dự án này. "Tạo skill" đúc kết cách làm thành skill. "Mở trong terminal" chỉ chép lệnh.',
  },
  'voice-pick': {
    title: 'Chọn giọng đọc',
    text: '2 thẻ radio: "Miễn phí" (VieNeu, chạy trên máy) và thẻ trả phí (vd ElevenLabs). Muốn đổi giọng: click thẻ đó, rồi bấm nút chạy (nút tự ghi chi phí) và nhờ người dùng tự đồng ý chi phí. App tự báo giọng đã chọn cho bước khi chạy — KHÔNG sửa lời dặn/quy trình. Thẻ trả phí bấm được, có "Nghe thử" nghĩa là khóa API đã có, tên giọng ghi sẵn trên thẻ — không hỏi lại. Muốn giọng khác: link "Đổi giọng". "▶ Nghe thử" không tốn tiền.',
  },
  'step-approve': {
    title: 'Duyệt kết quả',
    text: '"Duyệt" chỉ xác nhận kết quả bước này ổn, không chạy gì. "Sang bước tiếp →" mở bước sau; bước sau chưa tự chạy, phải bấm "Chạy" ở đó.',
  },
  'step-reply': {
    title: 'Claude đang hỏi',
    text: 'Bước dừng chờ trả lời. Gõ vào ô (hoặc bấm chip gợi ý), rồi "Gửi câu trả lời" = Claude làm tiếp từ chỗ dừng, ít token (nên dùng); "Chạy lại kèm góp ý" = chạy lại cả bước, tốn hơn. Nhiều câu hỏi thì trả lời lần lượt từng câu.',
  },
  cost: {
    title: 'Xác nhận chi phí',
    text: 'Nút "Đồng ý, chạy" bị chặn với trợ lý: báo người dùng mức tốn ước tính và nhờ họ tự bấm. Người dùng muốn miễn phí thì bấm nút "Dùng <phương án miễn phí>" nếu có. "Hủy" không tốn gì.',
  },
  pipelines: {
    title: 'Quy trình',
    text: 'Quy trình là khung các bước dùng khi tạo dự án. "Tạo quy trình mới": trả lời từng phần rồi "Lưu quy trình". Ở "Quy trình của tôi": "Sửa" (quy trình của người dùng), "Xem chi tiết", menu ⋯ có Nhân bản / Xuất YAML / Nhờ AI sửa / Xóa. Sửa quy trình KHÔNG đổi dự án đã tạo — đổi bước của 1 dự án thì dùng "Sửa quy trình" ở trang bước. Menu "Thêm" → "Phong cách của tôi" sửa nhánh "Phong cách" của Bộ não, mọi bước AI đều đọc. Bật "Nâng cao" mới thấy lời dặn AI, model, YAML.',
  },
  tts: {
    title: 'Giọng đọc',
    text: '"Thêm giọng đọc" → chọn dịch vụ → điền. Ô "Khóa API" là mật khẩu: trợ lý không gõ được, nhờ người dùng tự dán. "Đặt mặc định" chọn giọng mặc định cho các bước. "Đọc thử" của dịch vụ trả phí (ElevenLabs) trừ credit thật — hỏi người dùng trước khi bấm; VieNeu đọc thử miễn phí. Chọn giọng cho 1 video thì dùng thẻ giọng ngay ở bước Giọng đọc, không cần đổi mặc định.',
  },
  channels: {
    title: 'Kênh YouTube',
    text: 'Số liệu lấy từ YouTube; mỗi lần "Làm mới" tốn hạn mức API trong ngày. "+ Thêm kênh" cần "Thiết lập Google" xong trước. Bấm tên kênh để xem chi tiết.',
  },
  channel: {
    title: 'Trang kênh',
    text: '"Làm mới" lấy số liệu mới (tốn hạn mức API). "Xóa kênh" gỡ kênh khỏi app — chỉ làm khi người dùng yêu cầu rõ. Phần "Skills của kênh này" tick skill dùng cho kênh.',
  },
  skills: {
    title: 'Skills',
    text: 'Thư viện skill của app. Tick ô kênh trên bảng để gắn skill cho kênh; "Tất cả kênh" áp dụng cả kênh thêm sau. "Nhập skill" lấy từ máy, dán hoặc GitHub. Tab "Tìm skill": "Tìm nhanh" (AI, ít token), "Thảo luận" (AI hỏi lại vài câu), "Tìm rộng hơn trên web" (chậm, tốn token hơn).',
  },
  brain: {
    title: 'Bộ não',
    text: 'Cây ghi nhớ dùng chung (sở thích, quy tắc, bài học) mà trợ lý và các bước video đọc trước khi làm. Mục mới chỉ vào khi người dùng duyệt: muốn nhớ điều gì thì dùng công cụ đề xuất (brain_propose), KHÔNG tự bấm "Nhận"/"Sửa rồi nhận" thay người dùng. "+ Thêm ghi nhớ", "Sửa", "Xóa", "Khôi phục" chỉ làm khi người dùng yêu cầu rõ. "Nén" gọi Claude mức suy nghĩ cao nhất (tốn token) — hỏi trước khi bấm; "Áp dụng" bản nén là việc của người dùng. "Kiến thức gốc" là các chỉ dẫn này; người dùng sửa được ("Sửa", "Khôi phục mặc định") — chỉ sửa khi được yêu cầu rõ.',
  },
};

// Bản sửa của người dùng (server hints.json) — App/Bộ não nạp vào; hint(id) trả bản đang dùng.
let custom = {};
export function setHintOverrides(o) {
  custom = o && typeof o === 'object' ? o : {};
}
export function hint(id) {
  const h = HINTS[id];
  if (!h) return null;
  return Object.hasOwn(custom, id) ? { ...h, text: custom[id], custom: true } : { ...h, custom: false };
}
