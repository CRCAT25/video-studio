# Video Studio

Xưởng làm video chạy trên máy của bạn: chia việc làm video thành từng bước, giao từng bước cho
Claude Code (`claude -p`), bạn xem tiến độ và duyệt ngay trên trình duyệt.

Mọi dữ liệu ở trên máy bạn: file của mỗi video nằm trong thư mục dự án, còn DB và cài đặt nằm ở `~/.video-studio`.
App chỉ nghe ở `127.0.0.1`, máy khác không vào được.

## Cần có

- Node.js 20 trở lên (khuyên dùng 24)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) đã cài. Đăng nhập Claude làm được ngay trong app.
- macOS là tốt nhất: chạy nền, Keychain, mở đúng hồ sơ Chrome. Linux/Windows chạy được phần chính.

## Cài (một lần)

```sh
git clone <repo> video-studio && cd video-studio
npm install
npm run build
npm link        # tạo lệnh `video-studio` dùng được ở mọi thư mục
```

## Mở app

Mở terminal và gõ:

```sh
video-studio
```

Terminal in ra link `http://127.0.0.1:4317/`. Bấm vào link đó (Cmd+click) để mở app.
Giữ cửa sổ terminal mở trong lúc dùng app. Muốn tắt app thì bấm Ctrl+C.

Tùy chọn: `video-studio --open` để tự mở trình duyệt, `video-studio --port 4318` để đổi cổng, `video-studio --help`
để xem hết. Chưa chạy `npm link` thì dùng `npm start` trong thư mục repo cũng được.

Cập nhật bản mới: gõ `video-studio --update` (tự `git pull`, cài lại thư viện nếu cần, build lại giao diện), rồi tắt app đang mở và gõ lại `video-studio`. Đang chạy nền thì `video-studio service restart`.

## Đăng nhập

- **Mật khẩu** (mặc định): lần đầu mở app, bạn tạo mật khẩu. Để chắc chắn đúng là bạn, màn này hỏi thêm **mã thiết lập
  6 số** đang in ở terminal. Từ lần sau chỉ cần nhập mật khẩu; trình duyệt nhớ đăng nhập 30 ngày.
- **Quên mật khẩu:** chạy `video-studio reset-password` (chưa `npm link` thì `npm start -- reset-password`), rồi mở
  app và tạo mật khẩu mới bằng mã thiết lập nó in ra.
- **Google** (tùy chọn): làm xong *Thiết lập Google* trong app, rồi bấm **Bật đăng nhập Google** để đặt bạn làm chủ.
  Từ đó nút Google ở trang đăng nhập chỉ nhận đúng tài khoản này (mật khẩu vẫn dùng được). App chỉ xin quyền `openid`, không đọc email.

## Preset và kênh

Repo có sẵn preset mẫu `presets/tiktok-short.yaml` và danh sách kênh mẫu `presets/channels.yaml` (kênh không phải YouTube).
Kênh YouTube thêm ngay trong app: trang **Kênh** → **+ Thêm kênh** → đăng nhập tài khoản Google của kênh (cần làm *Thiết lập Google* trước).
Preset của riêng bạn đặt ở `~/.video-studio/presets/` (cùng định dạng). Preset trùng `id` sẽ ghi đè bản trong repo, và
`channels.yaml` ở đó được ưu tiên. Như vậy cập nhật code bằng `git pull` không đụng tới cấu hình của bạn.

## Chạy nền (macOS)

App tự chạy khi bạn đăng nhập máy và tự bật lại nếu bị tắt, ở cổng cố định 4318:

```sh
npm run service:install     # cài + bật
npm run open                # mở app (lần đầu in mã thiết lập)
npm run service:status      # xem có đang chạy không
npm run service:restart     # sau khi cập nhật code (nhớ npm run build trước)
npm run service:uninstall   # gỡ, giữ nguyên dữ liệu
```

Log nằm ở `~/.video-studio/logs/server.log`. DB được sao lưu mỗi ngày vào `~/.video-studio/backups`, giữ 7 bản.
Trước khi cài, hãy tắt bản `video-studio` đang chạy ở cùng cổng.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `VS_HOME` | thư mục dữ liệu (mặc định `~/.video-studio`) |
| `VS_PORT` | cổng (mặc định 4317) |
| `VS_TOKEN` | token ngầm cho test/dev (mặc định `VS_HOME/token`) |
| `VS_CLAUDE_BIN` | đường dẫn `claude` nếu không có trong PATH |
| `VS_MODEL` | model mặc định cho các bước |

## Phát triển

```sh
npm test                    # unit test
npm run e2e                 # chạy app thật bằng Chrome (playwright-core)
npm run dev:server          # server, kèm lệnh chạy Vite
npm run dev:web             # giao diện (Vite)
```

Giấy phép: [MIT](LICENSE). Quyền riêng tư: [PRIVACY.md](PRIVACY.md). Tài liệu thiết kế: [docs/spec.md](docs/spec.md), hợp đồng M1: [docs/m1-contract.md](docs/m1-contract.md).
