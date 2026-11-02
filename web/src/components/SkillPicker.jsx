// Chọn skill từ thư viện của app để gắn vào quy trình: value = mảng đường dẫn thư mục skill (trường `skills` của quy trình).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ImportModal } from '../pages/Skills.jsx';
import { useT } from '../lib/i18n.jsx';

// channelId: chỉ hiện skill dùng chung và skill của kênh này (skill kênh khác không áp dụng cho video của kênh).
export default function SkillPicker({ value = [], onChange, disabled = false, channelId = null }) {
  const t = useT();
  const [lib, setLib] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.skills().then((r) => { setLib(r.skills); return r.skills; }).catch(() => { setLib([]); return []; });
  useEffect(() => { load(); }, []);
  const on = new Set(value);
  const toggle = (path, yes) => onChange(yes ? [...value, path] : value.filter((p) => p !== path));
  // Nhập xong: tải lại thư viện và tự tick skill vừa nhập (nếu hiện được cho kênh này).
  const imported = async (names = []) => {
    const all = await load();
    const add = all.filter((s) => names.includes(s.name) && (s.shared || (channelId != null && s.channels.includes(channelId))) && !on.has(s.path)).map((s) => s.path);
    if (add.length) onChange([...value, ...add]);
  };
  if (!lib) return null;
  const shown = lib.filter((s) => s.shared || (channelId != null && s.channels.includes(channelId)));
  return (
    <div className="sk-pick">
      {shown.length ? shown.map((s) => (
        <label key={s.path} className="chk">
          <input type="checkbox" checked={on.has(s.path)} disabled={disabled} onChange={(e) => toggle(s.path, e.target.checked)} />
          <span>
            <b>{s.name}</b>
            {s.description ? <span className="hint">{s.description}</span> : null}
          </span>
        </label>
      )) : <span className="hint">{t('Thư viện chưa có skill phù hợp — thêm bên dưới.')}</span>}
      <div className="sk-pick-add">
        <button type="button" className="btn sm" disabled={disabled} onClick={() => setAdding(true)}>+ {t('Thêm skill')}</button>
      </div>
      {/* hộp nhập nằm trong form của hộp "Dự án mới": chặn Enter trong ô nhập để khỏi gửi form cha */}
      {adding ? (
        <div onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); }}>
          <ImportModal onClose={() => setAdding(false)} onDone={imported} />
        </div>
      ) : null}
    </div>
  );
}
