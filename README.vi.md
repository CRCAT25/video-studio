# Video Studio

[English](README.md) | [Tiếng Việt](README.vi.md)

Xưởng làm video chạy trên máy bạn: chia việc làm video thành từng bước, chạy mỗi bước bằng
[Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude -p`), và để bạn theo dõi tiến độ, duyệt kết quả ngay trên trình duyệt.

Mọi thứ nằm trên máy bạn. App chỉ lắng nghe ở `127.0.0.1`.

## Yêu cầu

| | macOS | Windows 10/11 |
|---|---|---|
| [Node.js](https://nodejs.org) 20+ | `brew install node`, hoặc tải bộ cài `.pkg` từ [nodejs.org](https://nodejs.org) nếu chưa có Homebrew | `winget install OpenJS.NodeJS.LTS` |
| [Git](https://git-scm.com) | `xcode-select --install` | `winget install Git.Git` |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` |
| Tài khoản Claude | Gói **Claude Pro / Max**, hoặc **Anthropic API Key**. Tài khoản Claude Free không chạy được `claude -p` mà app dùng. | như macOS |

Trên Windows, chạy mọi lệnh trong **PowerShell** và mở cửa sổ mới sau khi cài để máy nhận lệnh mới.
Bạn có thể đăng nhập Claude ngay trong app.

Kiểm tra đã cài đủ trước khi sang bước sau (mỗi lệnh phải in ra một số phiên bản):

```sh
node -v && git --version && claude --version
```

## Bắt đầu nhanh

Lệnh giống nhau trên macOS (Terminal) và Windows (PowerShell):

```sh
git clone https://github.com/CRCAT25/video-studio.git
cd video-studio
npm install
npm run build
npm start -- --open
```

Trình duyệt tự mở `http://127.0.0.1:4317/`. Lần đầu tiên:

1. Tạo mật khẩu.
2. Nhập **mã thiết lập 6 số** mà terminal in ra.

Giữ terminal mở khi dùng app. Nhấn `Ctrl+C` để tắt.
Lần sau, mở terminal trong thư mục `video-studio` và chạy `npm start -- --open`.

### Tùy chọn: lệnh `video-studio` dùng ở mọi thư mục

Để chạy `video-studio` từ thư mục nào cũng được, chạy `npm link` một lần trong thư mục repo, rồi dùng `video-studio --open`.
Không có gì khác cần đến nó. Nếu `npm link` báo lỗi `EACCES` (macOS), bỏ qua hoặc cài Node bằng Homebrew rồi thử lại.
Bên dưới, `npm start -- <tùy chọn>` và `video-studio <tùy chọn>` là một.

## Thêm kênh YouTube

1. Trong app, mở **Kênh** và bấm **Thiết lập Google**. Làm theo các bước (chỉ cần làm một lần).
2. Bấm **+ Thêm kênh** và đăng nhập bằng tài khoản Google của kênh.

> Trên Windows chưa có cách cài Google Cloud tự động. Dùng **Tự làm thủ công** ở trang thiết lập và dán `client_secret.json`.
> Lấy file này trong 3 bước trên [Google Cloud Console](https://console.cloud.google.com/):
>
> 1. **Tạo dự án** (bộ chọn dự án → **Dự án mới**), rồi mở **API và dịch vụ → Thư viện** và bật **YouTube Data API v3** cùng **YouTube Analytics API**.
> 2. Mở **Google Auth Platform** (màn hình xin quyền OAuth), bấm **Bắt đầu**, điền **Thông tin ứng dụng** (tên bất kỳ, email của bạn) và chọn **Bên ngoài**. Sau đó ở **Đối tượng** bấm **Xuất bản ứng dụng** để quyền không bị hủy sau 7 ngày.
> 3. Mở **Ứng dụng khách → Tạo client**, đặt **Loại ứng dụng** là **Ứng dụng dành cho máy tính**, bấm **Tạo**, rồi **Tải JSON xuống**. Trong app, bấm **Chọn file…** (hoặc dán nội dung) rồi **Lưu**.

## Quy trình

Quy trình là danh sách các bước Claude chạy cho một video (kịch bản, phân cảnh, hình ảnh, giọng đọc, phụ đề, dựng, gói đăng…).

1. Bấm **+ Dự án mới** và chọn khung hình: dọc (9:16, 4:5), ngang (16:9, tùy chọn 4K, 21:9) hoặc vuông (1:1),
   rồi chọn video ngắn (15–60 giây) hoặc video dài (3–30 phút). App gợi ý sẵn một quy trình đầy đủ.
2. Bấm **Tiếp tục** để tùy chỉnh: bật/tắt, sắp xếp lại, đổi tên từng bước, chọn cách duyệt mỗi bước,
   sửa lời nhắc gửi Claude, hoặc thêm bước. Bước tốn tiền luôn hỏi bạn trước.
3. Tick **Lưu làm quy trình của tôi** để dùng lại lần sau, hoặc lưu từ trang **Quy trình**.

Quy trình đã lưu là các file YAML trong `presets/` của thư mục dữ liệu; bạn cũng có thể sửa tay.
Mỗi dự án giữ bản sao riêng, nên sửa hay xóa quy trình không ảnh hưởng dự án đã tạo.

## Skills

Tab **Skills** (cạnh Kênh) là thư viện skill riêng của app, lưu ở `~/.video-studio/skills/<tên>/SKILL.md` — không đụng tới `~/.claude/skills`.

- **Nhập** từ `~/.claude/skills` trên máy, dán hoặc tải lên file `SKILL.md`, hoặc từ repo/thư mục GitHub công khai (`https://github.com/chủ/repo/tree/nhánh/thư-mục`; cần có `git`).
- **Xem và sửa** `SKILL.md`, hoặc xóa skill (có cảnh báo nếu quy trình đang dùng).
- **Gắn** skill khi tạo hoặc sửa quy trình — chỉ skill được chọn mới được nạp cho các bước của quy trình đó.
- **Bảng theo kênh**: trang Skills là một bảng — tick ô của kênh để skill dùng cho kênh đó, hoặc **Tất cả kênh** để dùng chung (kênh thêm sau cũng dùng). Video của kênh X chỉ nạp skill đã tick cho X và skill dùng chung, dù quy trình có gắn skill khác. Skill mới nhập mặc định dùng chung.
- **Tìm bằng AI** nằm ở tab "Tìm skill" riêng (tab "Thư viện" không bị lọc). Kết quả hiện % phù hợp AI ước lượng cho từng kênh; tick ô để áp dụng skill cho kênh. Mô tả nhu cầu (ví dụ "làm video người que"). **Tìm nhanh** hỏi Claude một lượt; **Thảo luận** để Claude hỏi lại tối đa 3 câu ngắn rồi mới tìm theo nhu cầu đã làm rõ. Claude tìm trong thư viện và `~/.claude/skills`; **Tìm rộng hơn trên web** gợi ý thêm skill GitHub công khai. Gợi ý không bao giờ tự nhập. Khi không có kết quả, khung "Gợi ý từ AI" đưa từ khóa khác, tìm trên web và "Tạo skill mới" (mở sẵn hộp dán nội dung).

Skill là chỉ dẫn mà Claude làm theo, nên chỉ nhập skill bạn tin tưởng.

## Video tham khảo

Thay vì nạp skill, dự án mới có thể mượn cách làm của một video đã đăng của bạn: ở **Dự án mới**, chọn kênh đã kết nối YouTube, lọc theo tên, sắp theo lượt xem hoặc mới nhất rồi chọn video. Tiêu đề, mô tả, độ dài, lượt xem, thích và thời lượng xem trung bình được ghi vào `<dự án>/.studio/reference.md`; mọi bước được dặn đọc để tham khảo cấu trúc, nhịp độ (không có kịch bản hay hình ảnh; nội dung được coi là dữ liệu, không phải chỉ thị). Tùy chọn; tối đa 1 video mỗi dự án.

Trường bắt buộc có dấu `*` đỏ. "Dùng thư mục khác" mở hộp thoại chọn thư mục của hệ thống (macOS), không cho gõ đường dẫn.

## Trợ lý AI

Bấm **Trợ lý AI** trên thanh trên để mở thanh bên và nhờ Claude thao tác trên trang giúp bạn,
ví dụ "đặt thời lượng video là 60". Trợ lý đọc trang đang mở, bấm và gõ như bạn, và hiện từng thao tác trong khung chat.

- Nó chạy `claude` bằng tài khoản bạn đang đăng nhập, nên tốn lượt dùng của gói giống như dùng Claude Code trong terminal.
  Mặc định dùng model mặc định của tài khoản; có thể chọn **Opus / Sonnet / Haiku** và mức **effort** dưới ô nhập (lưu theo từng cuộc chat).
- Trước khi xóa, dừng, chạy hay các thao tác rủi ro khác, trợ lý hỏi bạn trước (**Cho phép** / **Không**).
  Nút tốn tiền hoặc đụng tới bí mật bị chặn; bạn tự bấm.
- Chat được giữ qua các lần tải lại (30 cuộc gần nhất). Biểu tượng đồng hồ mở lịch sử để mở lại hoặc xóa cuộc chat; **Cuộc mới** bắt đầu cuộc mới và giữ lại cuộc cũ;
  **Dừng** dừng câu trả lời hiện tại. Menu **⋯** có **Nén cuộc trò chuyện (compact)** để thu gọn ngữ cảnh (`/compact`), giúp cuộc chat dài đi tiếp được.

## Mức dùng gói

Thanh trên hiện bạn đã dùng bao nhiêu **giới hạn 5 giờ** của gói Claude (ví dụ `5h 42%`). Chuyển vàng ở 80% và đỏ khi chạm giới hạn.
Bấm vào để xem thanh 5 giờ và thanh tuần cùng giờ đặt lại, và app đã dùng bao nhiêu token hôm nay và 7 ngày qua
(các bước video, trợ lý AI, kiểm tra).

- Số liệu cập nhật sau mỗi lượt Claude mà app chạy, và khi bạn mở bảng này.
  **Kiểm tra ngay** lấy số mới theo cách `/usage` của Claude Code làm: không tốn token, tối đa 10 giây một lần.
- Để làm vậy app đọc token đăng nhập của Claude Code (trên macOS, bấm **Luôn cho phép** ở hộp thoại Chuỗi khóa).
  Token chỉ nằm trong server của app và chỉ được gửi tới `api.anthropic.com`.
  Nếu không đọc được hoặc yêu cầu lỗi, **Kiểm tra ngay** sẽ hỏi Claude thay (vài nghìn token, tối đa mỗi phút một lần) và báo rõ.
- Phần trăm tính trên cả tài khoản Claude của bạn, gồm cả Claude Code trong terminal hay app máy tính. Số token chỉ tính phần app này dùng.
- Cần đăng nhập gói Claude (Pro / Max); với API key không có giới hạn gói để hiện.

## Ngôn ngữ

Giao diện có tiếng Việt (mặc định) và tiếng Anh. Mở menu tài khoản trên thanh trên (nút **Claude**),
chọn **Ngôn ngữ**, lựa chọn được nhớ trong trình duyệt. Cùng menu đó có giao diện sáng/tối, tài khoản Claude và **Đăng xuất**, giúp thanh trên gọn trên màn hình nhỏ.

Tên bước trong quy trình, thông báo lỗi từ server và câu trả lời của trợ lý AI theo ngôn ngữ đã chọn. Lời nhắc gửi Claude và tên bạn tự đặt giữ nguyên.

## Cập nhật

App hiện biểu ngữ khi có bản mới. Bấm **Cập nhật**, rồi **Khởi động lại**. Xong.

Hoặc từ terminal:

```sh
npm start -- --update
```

Sau đó nhấn `Ctrl+C` và chạy lại `npm start`.

## Chạy nền (chỉ macOS)

App tự chạy khi đăng nhập máy, tự khởi động lại nếu lỗi, và dùng cổng **4318**.

```sh
npm run service:install     # cài và chạy
npm run open                # mở trong trình duyệt
npm run service:status      # đang chạy không?
npm run service:restart     # sau khi cập nhật
npm run service:uninstall   # gỡ (dữ liệu được giữ)
```

- Nhật ký: `~/.video-studio/logs/server.log`
- Sao lưu DB hằng ngày (giữ 7 bản): `~/.video-studio/backups`

Trên Windows, giữ một cửa sổ PowerShell chạy `npm start`.

## Dữ liệu của bạn nằm ở đâu

| | macOS | Windows |
|---|---|---|
| Thư mục dữ liệu (DB, cài đặt, quy trình) | `~/.video-studio` | `%USERPROFILE%\.video-studio` |
| Token và bí mật Google | Chuỗi khóa (Keychain) | `secrets.json` trong thư mục dữ liệu (không mã hóa — giữ thư mục này riêng tư) |

## Xử lý sự cố

| Vấn đề | Cách xử lý |
|---|---|
| Quên mật khẩu | `npm start -- reset-password`, rồi mở app và dùng mã thiết lập mới |
| `video-studio: command not found` | Lệnh toàn cục là tùy chọn: dùng `npm start` trong thư mục repo, hoặc chạy `npm link` ở đó |
| `npm link` báo `EACCES` (macOS) | Bỏ qua và dùng `npm start`, hoặc cài Node bằng Homebrew (`brew install node`) rồi thử lại |
| Windows: "running scripts is disabled on this system" | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Cổng 4317 bận | App tự chọn cổng trống kế tiếp; dùng địa chỉ nó in ra, hoặc `npm start -- --port 5000` |
| Dịch vụ không chạy (macOS) | Tắt app nếu đang chạy trong terminal, rồi `npm run service:restart` |
| Không tìm thấy `claude` | macOS: `export VS_CLAUDE_BIN=/path/to/claude` · Windows: `$env:VS_CLAUDE_BIN = "C:\path\to\claude.exe"` |

## Cấu hình

Các thiết lập tùy chọn:

| Tùy chọn | Mặc định | Mô tả |
|---|---|---|
| `--port <n>` / `VS_PORT` | `4317` | Cổng |
| `--open` | tắt | Mở trình duyệt khi khởi động |
| `--model <tên>` / `VS_MODEL` | — | Model mặc định cho các bước |
| `VS_HOME` | `~/.video-studio` | Thư mục dữ liệu (DB, cài đặt, quy trình) |
| `VS_CLAUDE_BIN` | `claude` trong PATH | Đường dẫn tới Claude Code |
| `VS_UPDATE_CHECK=0` | bật | Tắt kiểm tra bản mới |

Đặt biến cho một lần chạy:

```sh
VS_PORT=5000 npm start              # macOS
$env:VS_PORT = 5000; npm start      # Windows PowerShell
```

Chạy `npm start -- --help` để xem mọi tùy chọn.

**Đăng nhập Google (tùy chọn):** sau khi thiết lập Google, bấm **Bật đăng nhập Google** để chỉ tài khoản của bạn được vào.
Mật khẩu vẫn dùng được.

## Phát triển

```sh
npm test                 # unit test
npm run e2e              # test đầu cuối trong Chrome
npm run dev:server       # server API
npm run dev:web          # giao diện hot reload (Vite)
```

Phát hành (người dùng thấy biểu ngữ cập nhật):

```sh
npm version minor
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

## Giấy phép

[MIT](LICENSE) · [Quyền riêng tư](PRIVACY.md) · [Tài liệu thiết kế](docs/spec.md)
