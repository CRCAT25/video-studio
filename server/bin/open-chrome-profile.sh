#!/bin/sh
# Dùng làm BROWSER cho `claude auth login`: mở link đăng nhập trong hồ sơ Chrome $VS_CHROME_PROFILE.
# Server chỉ đặt VS_CHROME_PROFILE từ danh sách hồ sơ đọc được của Chrome (không nhận chuỗi tùy ý).
url="$1"
[ -n "$url" ] || exit 1
if [ "$(uname)" = "Darwin" ]; then
  exec open -na "Google Chrome" --args --profile-directory="$VS_CHROME_PROFILE" "$url"
fi
for bin in google-chrome google-chrome-stable; do
  if command -v "$bin" >/dev/null 2>&1; then
    exec "$bin" --profile-directory="$VS_CHROME_PROFILE" "$url"
  fi
done
exit 1
