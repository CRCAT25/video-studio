#!/usr/bin/env node
// osascript giả cho hộp thoại chọn thư mục: in $FAKE_PICK_DIR (hoặc báo Hủy khi không đặt) — không mở UI thật.
if (!process.env.FAKE_PICK_DIR) {
  process.stderr.write('execution error: User canceled. (-128)\n');
  process.exit(1);
}
process.stdout.write(`${process.env.FAKE_PICK_DIR}/\n`);
