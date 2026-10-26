#!/usr/bin/env node
// gcloud giả cho test "Thiết lập Google tự động" — không mạng, không đăng nhập thật.
// Trạng thái đăng nhập: file $CLOUDSDK_CONFIG/fake-auth. FAKE_GCLOUD_LOGIN=fail → đăng nhập thất bại.
// FAKE_GCLOUD_LOG=<file> → ghi mỗi lệnh 1 dòng JSON {args, browser, profile} (kiểm tra env truyền vào).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.CLOUDSDK_CONFIG;
const auth = dir ? path.join(dir, 'fake-auth') : null;
if (process.env.FAKE_GCLOUD_LOG) {
  fs.appendFileSync(process.env.FAKE_GCLOUD_LOG, `${JSON.stringify({ args, browser: process.env.BROWSER || null, profile: process.env.VS_CHROME_PROFILE || null, python: process.env.CLOUDSDK_PYTHON || null })}\n`);
}
const cmd = args.slice(0, 2).join(' ');

if (!auth) process.exit(2);
if (cmd === 'auth login') {
  if (process.env.FAKE_GCLOUD_LOGIN === 'fail') process.exit(1);
  const ms = Number(process.env.FAKE_GCLOUD_LOGIN_MS || 0);
  if (ms) await new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(auth, 'ok');
  process.stdout.write('fake@example.invalid\n');
  process.exit(0);
}
if (cmd === 'auth print-access-token') {
  if (!fs.existsSync(auth)) process.exit(1);
  process.stdout.write('fake-cloud-token\n');
  process.exit(0);
}
if (cmd === 'auth revoke') {
  fs.rmSync(auth, { force: true });
  process.exit(0);
}
process.exit(2);
