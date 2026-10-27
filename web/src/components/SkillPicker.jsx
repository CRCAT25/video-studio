// Chọn skill từ thư viện của app để gắn vào quy trình: value = mảng đường dẫn thư mục skill (trường `skills` của quy trình).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

// channelId: chỉ hiện skill dùng chung và skill của kênh này (skill kênh khác không áp dụng cho video của kênh).
export default function SkillPicker({ value = [], onChange, disabled = false, channelId = null }) {
  const t = useT();
  const [lib, setLib] = useState(null);
  useEffect(() => {
    api.skills().then((r) => setLib(r.skills)).catch(() => setLib([]));
  }, []);
  const on = new Set(value);
  const toggle = (path, yes) => onChange(yes ? [...value, path] : value.filter((p) => p !== path));
  if (!lib) return null;
  const shown = lib.filter((s) => s.shared || (channelId != null && s.channels.includes(channelId)));
  if (!shown.length) return <span className="hint">{t('Thư viện chưa có skill — thêm ở tab Skills.')}</span>;
  return (
    <div className="sk-pick">
      {shown.map((s) => (
        <label key={s.path} className="chk">
          <input type="checkbox" checked={on.has(s.path)} disabled={disabled} onChange={(e) => toggle(s.path, e.target.checked)} />
          <span>
            <b>{s.name}</b>
            {s.description ? <span className="hint">{s.description}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}
