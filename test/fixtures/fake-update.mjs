// Thay `cli.js --update` khi test: in vài dòng rồi thoát; FAKE_UPDATE_FAIL=1 → thoát lỗi.
console.log('Đang tải bản mới…');
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_UPDATE_MS || 800)));
if (process.env.FAKE_UPDATE_FAIL === '1') {
  console.error('git pull không thành công: giả lập lỗi');
  process.exit(1);
}
console.log('Đã cập nhật abc1234 → def5678 (3 thay đổi).');
