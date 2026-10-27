// Từ một lần bị chặn quyền → danh sách quy tắc có thể cấp bằng nút (khớp validateGrantRule ở server).
const TOOL = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
// Khớp ONCE_ONLY_CMDS ở server: chỉ cấp được lần này.
const ONCE_ONLY = new Set(['find']);
const UNSAFE_FIND = /(^|\s)-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(\s|$)/;
const WORD = /^[A-Za-z0-9._-]{1,40}$/;
const DANGEROUS = new Set([
  'rm', 'sudo', 'su', 'doas', 'curl', 'wget', 'git', 'chmod', 'chown', 'kill', 'killall', 'pkill', 'dd', 'ssh', 'scp', 'sh', 'bash', 'zsh', 'fish',
  'eval', 'exec', 'xargs', 'find', 'env', 'nohup', 'osascript', 'launchctl', 'open', 'npm', 'npx', 'pnpm', 'yarn', 'brew', 'pip', 'pip3', 'mkfs',
  'diskutil', 'shutdown', 'reboot', 'security',
]);

// Lệnh Bash → các từ lệnh đầu mỗi vế (bỏ heredoc, gán biến môi trường); null nếu có lệnh không cấp được.
function bashWords(cmd) {
  const head = String(cmd).split('<<')[0];
  const words = [];
  for (const part of head.split(/&&|\|\||;|\||\n/)) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
    if (!toks.length) continue;
    const w = toks[0];
    if (!WORD.test(w)) return null;
    if (ONCE_ONLY.has(w) && UNSAFE_FIND.test(part)) return null;
    if (DANGEROUS.has(w.toLowerCase()) && !ONCE_ONLY.has(w)) return null;
    if (!words.includes(w)) words.push(w);
  }
  return words.length ? words : null;
}

export function grantRules(d) {
  if (!d || typeof d !== 'object') return [];
  const tool = d.tool ?? d.tool_name;
  if (typeof tool !== 'string') return [];
  if (tool === 'Bash') {
    const input = d.input ?? d.tool_input;
    const cmd = input && typeof input === 'object' ? input.command : null;
    const words = typeof cmd === 'string' ? bashWords(cmd) : null;
    return words ? words.map((w) => `Bash(${w} *)`) : [];
  }
  return TOOL.test(tool) ? [tool] : [];
}

// Quy tắc chỉ được cấp "lần này" (không lưu vào dự án/mọi dự án).
export const isOnceOnly = (rule) => {
  const m = /^Bash\(([^ ]+) \*\)$/.exec(rule);
  return !!m && ONCE_ONLY.has(m[1]);
};
