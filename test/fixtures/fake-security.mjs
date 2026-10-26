#!/usr/bin/env node
// Giả lập lệnh macOS `security` cho test kho Keychain — lưu vào file JSON ở env FAKE_SECURITY_DB, ghi argv vào FAKE_SECURITY_LOG.
// Hỗ trợ: find-generic-password -a A -s S -w · delete-generic-password -a A -s S · -i (stdin: add-generic-password -U -a "A" -s "S" -X hex).
// FAKE_SECURITY_FAIL=1 → thoát mã 1.
import fs from 'node:fs';

const DB = process.env.FAKE_SECURITY_DB;
const argv = process.argv.slice(2);
if (process.env.FAKE_SECURITY_LOG) fs.appendFileSync(process.env.FAKE_SECURITY_LOG, `${JSON.stringify(argv)}\n`);
if (process.env.FAKE_SECURITY_FAIL === '1') process.exit(1);

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return {};
  }
};
const save = (o) => fs.writeFileSync(DB, JSON.stringify(o));
const val = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (argv[0] === 'find-generic-password') {
  const v = load()[`${val(argv, '-s')}/${val(argv, '-a')}`];
  if (v === undefined) {
    process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
    process.exit(44);
  }
  process.stdout.write(`${v}\n`);
  process.exit(0);
}
if (argv[0] === 'delete-generic-password') {
  const o = load();
  const k = `${val(argv, '-s')}/${val(argv, '-a')}`;
  if (!(k in o)) process.exit(44);
  delete o[k];
  save(o);
  process.exit(0);
}
if (argv[0] === '-i') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const line = Buffer.concat(chunks).toString('utf8').trim();
  const m = /^add-generic-password -U -a "([^"]+)" -s "([^"]+)" -X ([0-9a-f]+)$/.exec(line);
  if (!m) process.exit(2);
  const o = load();
  o[`${m[2]}/${m[1]}`] = Buffer.from(m[3], 'hex').toString('utf8');
  save(o);
  process.exit(0);
}
process.exit(2);
