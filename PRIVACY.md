# Chính sách quyền riêng tư — Video Studio

*Cập nhật: 26/10/2026 · [English below](#privacy-policy--video-studio)*

Video Studio là phần mềm mã nguồn mở, chạy trên máy tính của chính bạn (chỉ nghe ở `127.0.0.1`).
Người viết phần mềm **không có máy chủ** và **không nhận, không xem, không lưu** bất kỳ dữ liệu nào của bạn.

## Dữ liệu Google mà app dùng

Khi bạn thêm kênh YouTube, app xin các quyền sau, chỉ cho chính tài khoản bạn đăng nhập:

| Quyền | Dùng để |
|---|---|
| `youtube.readonly` | đọc tên kênh, số người đăng ký, danh sách video |
| `yt-analytics.readonly` | đọc số liệu lượt xem, thời gian xem |
| `youtube.upload`, `youtube.force-ssl` | tải video lên kênh của bạn — chỉ xin khi bạn bật tải lên, và chỉ tải khi bạn bấm |
| `openid` (đăng nhập app, tùy chọn) | nhận diện bạn là chủ app; app chỉ lưu mã băm, không đọc email hay tên |

## Lưu ở đâu

- Token Google lưu trong kho bí mật của máy (Keychain trên macOS), không bao giờ gửi tới trình duyệt hay ghi vào log.
- Tên kênh, mã kênh và số liệu tạm (làm mới mỗi 6 giờ) lưu trong file SQLite ở `~/.video-studio` trên máy bạn.
- App không gửi dữ liệu này tới bất kỳ ai. Kết nối duy nhất ra ngoài là tới máy chủ của Google, để làm đúng việc ở bảng trên.

## Xóa dữ liệu

- Bấm **Xóa kênh** trong app: app thu hồi quyền ở Google và xóa token, số liệu của kênh đó.
- Hoặc thu hồi bất cứ lúc nào tại https://myaccount.google.com/permissions.
- Xóa thư mục `~/.video-studio` để xóa toàn bộ dữ liệu của app.

Việc app dùng và chuyển thông tin nhận từ Google API tuân theo
[Chính sách dữ liệu người dùng của Google API Services](https://developers.google.com/terms/api-services-user-data-policy),
bao gồm các yêu cầu về Sử dụng giới hạn (Limited Use).

Liên hệ: mở issue tại https://github.com/CRCAT25/video-studio/issues.

---

# Privacy Policy — Video Studio

*Updated: 2026-10-26*

Video Studio is open-source software that runs on your own computer (listening on `127.0.0.1` only).
The author runs **no server** and **does not receive, view or store** any of your data.

**Google data used.** When you add a YouTube channel, the app requests, for your own account only:
`youtube.readonly` (channel name, subscribers, video list), `yt-analytics.readonly` (views, watch time),
`youtube.upload` and `youtube.force-ssl` (upload videos to your channel — requested only if you enable uploads, used only when you click upload),
and optionally `openid` (to recognise you as the app owner; only a hash is stored — no email or name).

**Storage.** Google tokens are kept in your machine's secret store (Keychain on macOS) and never reach the browser or logs.
Channel names, IDs and cached statistics (refreshed every 6 hours) are stored in a local SQLite file under `~/.video-studio`.
Nothing is shared with anyone; the only outbound connections are to Google's APIs for the purposes above.

**Deletion.** Click **Xóa kênh** (Remove channel) in the app to revoke access at Google and delete that channel's tokens and data,
or revoke at any time at https://myaccount.google.com/permissions. Deleting `~/.video-studio` removes all app data.

Video Studio's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

Contact: open an issue at https://github.com/CRCAT25/video-studio/issues.
